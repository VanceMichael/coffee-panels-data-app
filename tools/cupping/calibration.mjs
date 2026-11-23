// 校准层：仅在「可信共同参照 + 同一评分版本」下让两个评审小组可比。
// 图节点为 小组@评分版本；参照盲样被复判撤除的边直接失效。
// 区间同时包含独立杯次噪声（随杯数下降）与场次/小组共享偏差（不随杯数下降）。

const nodeId = (panel, version) => `${panel}@${version}`;

export function buildNodes(cupRecords) {
  const nodes = new Map();
  for (const cup of cupRecords) {
    if (cup.usability !== 'usable') continue;
    const id = nodeId(cup.panel, cup.version);
    if (!nodes.has(id)) nodes.set(id, { id, panel: cup.panel, version: cup.version });
  }
  return nodes;
}

// 每个参照在两个节点上都有未撤除盲样、且评分版本一致时，才形成一条校准边。
export function buildEdges(referenceIndex, cupRecords) {
  const edges = [];
  for (const [reference, blinds] of referenceIndex) {
    const active = blinds.filter(item => item.state !== 'withdrawn');
    const byNode = new Map();
    for (const item of active) {
      for (const cup of cupRecords.filter(c => c.blind === item.blind && c.usability === 'usable')) {
        const id = nodeId(cup.panel, cup.version);
        if (!byNode.has(id)) byNode.set(id, { node: id, panel: cup.panel, version: cup.version, blindCups: new Map() });
        const entry = byNode.get(id);
        if (!entry.blindCups.has(item.blind)) entry.blindCups.set(item.blind, []);
        entry.blindCups.get(item.blind).push(cup);
      }
    }
    const nodeList = [...byNode.keys()].sort();
    for (let i = 0; i < nodeList.length; i += 1) {
      for (let j = i + 1; j < nodeList.length; j += 1) {
        const a = byNode.get(nodeList[i]);
        const b = byNode.get(nodeList[j]);
        if (a.version !== b.version) {
          edges.push({
            reference,
            from: nodeList[i],
            to: nodeList[j],
            sharedBlinds: [],
            rejected: true,
            rejectReason: `VERSION_MISMATCH:${nodeList[i]} 与 ${nodeList[j]} 评分版本不同，资料未约定固定换算，保留各自信息不可比`,
            refs: { [nodeList[i]]: [...a.blindCups.keys()].sort(), [nodeList[j]]: [...b.blindCups.keys()].sort() },
          });
          continue;
        }
        const sharedBlinds = [...a.blindCups.keys()].filter(blind => b.blindCups.has(blind));
        edges.push({
          reference,
          from: nodeList[i],
          to: nodeList[j],
          sharedBlinds: sharedBlinds.sort(),
          rejected: false,
          rejectReason: null,
          refs: {
            [nodeList[i]]: [...a.blindCups.keys()].sort(),
            [nodeList[j]]: [...b.blindCups.keys()].sort(),
          },
        });
      }
    }
  }
  return edges;
}

export function connectedComponents(nodes, edges) {
  const validEdges = edges.filter(edge => !edge.rejected);
  const adjacency = new Map([...nodes.keys()].map(id => [id, []]));
  for (const edge of validEdges) {
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }
  const seen = new Set();
  const components = [];
  for (const id of [...nodes.keys()].sort()) {
    if (seen.has(id)) continue;
    const queue = [id];
    const member = [];
    seen.add(id);
    while (queue.length) {
      const current = queue.shift();
      member.push(current);
      for (const next of adjacency.get(current) || []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    member.sort();
    const panels = [...new Set(member.map(node => node.split('@')[0]))].sort();
    const versions = [...new Set(member.map(node => node.split('@')[1]))].sort();
    components.push({
      id: `G${components.length + 1}`,
      nodes: member,
      panels,
      versions,
      anchored: validEdges.some(edge => member.includes(edge.from) && member.includes(edge.to)),
      edgeRefs: validEdges
        .filter(edge => member.includes(edge.from) && member.includes(edge.to))
        .map(edge => edge.reference),
    });
  }
  return components;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// 杯间合并标准差（数值项），带合同先验，防止单盲样小样本把 σ 压到 0。
export function pooledSigmas(cupRecords, config) {
  const sigmas = {};
  for (const measure of config.numericMeasures) {
    let sumSq = config.variancePrior[measure].sigma0 ** 2 * config.variancePrior[measure].pseudoDf;
    let df = config.variancePrior[measure].pseudoDf;
    const byBlind = new Map();
    for (const cup of cupRecords) {
      if (cup.usability !== 'usable' || cup.values[measure] === null) continue;
      if (!byBlind.has(cup.blind)) byBlind.set(cup.blind, []);
      byBlind.get(cup.blind).push(cup.values[measure]);
    }
    for (const values of byBlind.values()) {
      if (values.length < 2) continue;
      const m = mean(values);
      sumSq += values.reduce((sum, value) => sum + (value - m) ** 2, 0);
      df += values.length - 1;
    }
    sigmas[measure] = Math.sqrt(sumSq / df);
  }
  return sigmas;
}

function blindMeans(cupRecords, measure) {
  const byBlind = new Map();
  for (const cup of cupRecords) {
    if (cup.usability !== 'usable' || cup.values[measure] === null) continue;
    if (!byBlind.has(cup.blind)) byBlind.set(cup.blind, []);
    byBlind.get(cup.blind).push(cup.values[measure]);
  }
  return new Map([...byBlind].map(([blind, values]) => [blind, { mean: mean(values), n: values.length }]));
}

// 每个分量内：以第一个节点为锚（偏移 0），BFS 沿参照边传播 o_b = o_a + 均值差。
// 传播使用第一个数值项（同一份杯测合同下各数值项共享小组校准结构），边残差逐项另算。
export function estimateOffsets(component, edges, cupRecords, config, sigmas) {
  const offsets = new Map();
  for (const id of component.nodes) offsets.set(id, { offset: 0, se: 0, path: [], anchored: false });
  if (!component.anchored) {
    return { offsets, edgeChecks: [], reason: 'UNANCHORED_COMPONENT' };
  }
  const anchor = component.nodes[0];
  const primaryMeasure = config.numericMeasures[0];
  const primaryMeans = blindMeans(cupRecords, primaryMeasure);
  offsets.set(anchor, { offset: 0, se: 0, path: [], anchored: true });
  const internalEdges = edges.filter(edge => !edge.rejected && component.nodes.includes(edge.from) && component.nodes.includes(edge.to));
  const adjacency = new Map(component.nodes.map(id => [id, []]));
  for (const edge of internalEdges) {
    adjacency.get(edge.from).push(edge);
    adjacency.get(edge.to).push(edge);
  }
  const queue = [anchor];
  const settled = new Set([anchor]);
  while (queue.length) {
    const current = queue.shift();
    for (const edge of adjacency.get(current)) {
      const next = edge.from === current ? edge.to : edge.from;
      if (settled.has(next)) continue;
      const direction = edge.from === current ? 1 : -1;
      const sideFrom = edge.refs[edge.from].map(blind => primaryMeans.get(blind)?.mean).filter(Number.isFinite);
      const sideTo = edge.refs[edge.to].map(blind => primaryMeans.get(blind)?.mean).filter(Number.isFinite);
      const delta = sideFrom.length && sideTo.length ? mean(sideTo) - mean(sideFrom) : 0;
      const seEdge = sideFrom.length && sideTo.length
        ? sigmas[primaryMeasure] * Math.sqrt(1 / sideFrom.length + 1 / sideTo.length)
        : 0;
      offsets.set(next, {
        offset: offsets.get(current).offset + direction * delta,
        se: Math.sqrt(offsets.get(current).se ** 2 + seEdge ** 2),
        path: [...offsets.get(current).path, edge.reference],
        anchored: true,
      });
      settled.add(next);
      queue.push(next);
    }
  }
  // 边残差（环闭合检查）：每个数值项比较观测均值差与偏移隐含差。
  const edgeChecks = [];
  for (const edge of internalEdges) {
    for (const measure of config.numericMeasures) {
      const means = blindMeans(cupRecords, measure);
      const sideFrom = edge.refs[edge.from].map(blind => means.get(blind)?.mean).filter(Number.isFinite);
      const sideTo = edge.refs[edge.to].map(blind => means.get(blind)?.mean).filter(Number.isFinite);
      if (!sideFrom.length || !sideTo.length) continue;
      const observed = mean(sideTo) - mean(sideFrom);
      const implied = offsets.get(edge.to).offset - offsets.get(edge.from).offset;
      edgeChecks.push({
        reference: edge.reference,
        from: edge.from,
        to: edge.to,
        measure,
        observedDelta: round(observed),
        impliedDelta: round(implied),
        residual: round(observed - implied),
      });
    }
  }
  return { offsets, edgeChecks, reason: null };
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}

// 实货批证据：按分量分组的数值项区间与缺陷计数；多分量证据不合并。
export function buildLotEvidence(lotMap, cupRecords, components, offsetByComponent, sigmas, config) {
  const evidence = new Map();
  const nodeComponent = new Map();
  for (const component of components) {
    for (const node of component.nodes) nodeComponent.set(node, component);
  }
  for (const [lotId, lot] of lotMap) {
    const usableCups = cupRecords.filter(cup => lot.cups.includes(cup.cup) && cup.usability === 'usable');
    const groups = new Map();
    for (const cup of usableCups) {
      const node = nodeId(cup.panel, cup.version);
      const component = nodeComponent.get(node);
      if (!component) continue;
      if (!groups.has(component.id)) {
        groups.set(component.id, {
          componentId: component.id,
          version: component.versions.length === 1 ? component.versions[0] : null,
          panels: [],
          anchored: component.anchored,
          cups: [],
          measures: {},
          defects: [],
          reasons: [],
        });
      }
      const group = groups.get(component.id);
      if (!group.panels.includes(cup.panel)) group.panels.push(cup.panel);
      group.cups.push(cup.cup);
      if (cup.values.defect !== null) group.defects.push(cup.values.defect);
    }
    for (const group of groups.values()) {
      group.panels.sort();
      group.cups.sort();
      if (!group.anchored) group.reasons.push('UNANCHORED_PANEL:小组无有效共同参照，区间只在该小组原始量表内成立，不能跨组换算');
      const component = components.find(c => c.id === group.componentId);
      const offsetInfo = offsetByComponent.get(component.id);
      for (const measure of config.numericMeasures) {
        const observations = usableCups
          .filter(cup => group.cups.includes(cup.cup) && cup.values[measure] !== null)
          .map(cup => {
            const node = nodeId(cup.panel, cup.version);
            const info = offsetInfo.offsets.get(node);
            const offset = info && component.anchored ? info.offset : 0;
            return {
              cup: cup.cup,
              panel: cup.panel,
              raw: cup.values[measure],
              adjusted: round(cup.values[measure] - offset),
              missing: false,
            };
          });
        const missing = usableCups
          .filter(cup => group.cups.includes(cup.cup) && cup.values[measure] === null)
          .map(cup => ({ cup: cup.cup, panel: cup.panel, raw: null, adjusted: null, missing: true }));
        if (!observations.length) {
          group.measures[measure] = { status: 'NO_EVIDENCE', observations: missing, reasons: ['MEASURE_MASKED:该项被遮盖或记录欠缺，无法判断该采购要求'] };
          continue;
        }
        const n = observations.length;
        const point = mean(observations.map(o => o.adjusted));
        const offsetSe = Math.max(0, ...[...offsetInfo.offsets.values()].map(info => component.anchored ? info.se : 0));
        const seCommon = Math.max(config.sharedBiasFloor, offsetSe);
        const se = Math.sqrt(seCommon ** 2 + sigmas[measure] ** 2 / n);
        const z = config.intervalZ;
        group.measures[measure] = {
          status: 'OK',
          observations: [...observations, ...missing].sort((a, b) => a.cup.localeCompare(b.cup)),
          n,
          point: round(point),
          seCommon: round(seCommon),
          seCup: round(sigmas[measure] / Math.sqrt(n)),
          interval: { low: round(point - z * se, 4), high: round(point + z * se, 4) },
          reasons: component.anchored ? [] : ['UNANCHORED_PANEL'],
        };
      }
      group.defects = [...group.defects].sort((a, b) => a - b);
    }
    const unusableCups = cupRecords.filter(cup => lot.cups.includes(cup.cup) && cup.usability !== 'usable');
    evidence.set(lotId, {
      lot: lotId,
      groups: [...groups.values()],
      unusableCups: unusableCups.map(cup => ({ cup: cup.cup, reason: cup.unusableReason, panel: cup.panel })),
      disjoint: groups.size > 1,
      disjointReason: groups.size > 1
        ? 'DISJOINT_COMPONENTS:批次证据落在互不连通的小组/量表上，各自保留，禁止合并为单一区间'
        : null,
    });
  }
  return evidence;
}
