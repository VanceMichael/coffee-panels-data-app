// 判定层：杯测合同规则（rules.csv）+ 报价档（purchase.band）+ 货期/批量约束。
// 严格区分：整杯不可用（identity 已标 unusable）与单项不可判（遮盖/欠缺/杯间超限）。
// 区间跨过门槛时一律 INDETERMINATE，不增加小数位强行挑胜。

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function findDisagreements(cupRecords, blindMap, rules, config) {
  const findings = [];
  const byBlind = new Map();
  for (const cup of cupRecords) {
    if (cup.usability !== 'usable') continue;
    if (!byBlind.has(cup.blind)) byBlind.set(cup.blind, []);
    byBlind.get(cup.blind).push(cup);
  }
  const ruleMap = new Map();
  for (const rule of rules) {
    if (!ruleMap.has(rule.profile)) ruleMap.set(rule.profile, new Map());
    ruleMap.get(rule.profile).set(rule.measure, rule);
  }
  for (const [blind, cups] of byBlind) {
    const blindInfo = blindMap.get(blind);
    if (!blindInfo?.lot) continue;
    for (const [profile, measureRules] of ruleMap) {
      for (const [measure, rule] of measureRules) {
        const values = cups.map(cup => cup.values[measure]).filter(value => value !== null);
        if (values.length < 2) continue;
        const range = Math.max(...values) - Math.min(...values);
        if (range > rule.max_disagreement) {
          findings.push({
            code: 'DISAGREEMENT_EXCEEDED',
            profile,
            measure,
            lot: blindInfo.lot,
            blind,
            cups: cups.map(cup => cup.cup).sort(),
            range: Number(range.toFixed(4)),
            maxDisagreement: rule.max_disagreement,
            scope: 'MEASURE',
            note: config.countMeasures.includes(measure)
              ? '计数项杯间不一致，该要求只能等待补测，不直接作废整杯'
              : '杯间差异超出杯测合同，该单项暂不可判，其余项继续有效',
          });
        }
      }
    }
  }
  // 同一盲样同一测量项可能被多个 profile 的规则命中，去重后只保留一条事实，profile 维度并入列表。
  const deduped = new Map();
  for (const finding of findings) {
    const key = `${finding.blind}:${finding.measure}`;
    if (!deduped.has(key)) {
      deduped.set(key, { ...finding, profiles: [finding.profile] });
    } else {
      deduped.get(key).profiles.push(finding.profile);
    }
  }
  return [...deduped.values()].map(({ profile, ...rest }) => rest).sort((a, b) => a.blind.localeCompare(b.blind));
}

function measureVerdict(groupMeasure, rule, config) {
  if (!groupMeasure || groupMeasure.status === 'NO_EVIDENCE') {
    return { verdict: 'NO_EVIDENCE', reasons: ['MEASURE_MASKED:该项被遮盖或记录欠缺'] };
  }
  const { interval } = groupMeasure;
  if (config.countMeasures.includes(rule.measure)) {
    return { verdict: 'NO_INTERVAL', reasons: ['COUNT_MEASURE:计数项按合同上下限直接判定'] };
  }
  if (rule.limit_kind === 'lower') {
    if (interval.low >= rule.limit) return { verdict: 'PASS', reasons: [] };
    if (interval.high < rule.limit) return { verdict: 'FAIL', reasons: [`BELOW_LIMIT:区间上界 ${interval.high} 低于门槛 ${rule.limit}`] };
    return { verdict: 'INDETERMINATE', reasons: [`LIMIT_STRADDLE:区间 [${interval.low}, ${interval.high}] 跨过门槛 ${rule.limit}，禁止以更多小数位强行判定`] };
  }
  if (interval.high <= rule.limit) return { verdict: 'PASS', reasons: [] };
  if (interval.low > rule.limit) return { verdict: 'FAIL', reasons: [`ABOVE_LIMIT:区间下界 ${interval.low} 高于上限 ${rule.limit}`] };
  return { verdict: 'INDETERMINATE', reasons: [`LIMIT_STRADDLE:区间 [${interval.low}, ${interval.high}] 跨过上限 ${rule.limit}`] };
}

// 未锚定闸门：没有可信共同参照的小组，原始量表内的数字仍保留，但采购判定一律挂起。
function applyAnchorGate(base, numericVerdict) {
  if (base.anchored) return numericVerdict;
  const reasons = [...numericVerdict.reasons, 'UNANCHORED_PANEL:该小组无有效共同参照，小组内分数仅在其原始量表内成立，采购判定挂起等待参照补测'];
  if (numericVerdict.verdict === 'NO_EVIDENCE') return { ...numericVerdict, reasons };
  return { ...numericVerdict, verdict: 'INDETERMINATE', reasons };
}

function countVerdict(group, rule) {
  if (!group.defects.length && rule.measure === 'defect') {
    return { verdict: 'NO_EVIDENCE', reasons: ['MEASURE_MASKED:计数项无记录'] };
  }
  if (rule.measure !== 'defect') return { verdict: 'NO_INTERVAL', reasons: [] };
  const values = group.defects;
  if (rule.limit_kind === 'upper') {
    if (Math.max(...values) <= rule.limit) return { verdict: 'PASS', reasons: [] };
    return { verdict: 'FAIL', reasons: [`DEFECT_OVER_LIMIT:观测计数 ${values.join('|')} 超过上限 ${rule.limit}`] };
  }
  if (Math.min(...values) >= rule.limit) return { verdict: 'PASS', reasons: [] };
  return { verdict: 'FAIL', reasons: [`DEFECT_UNDER_LIMIT:观测计数低于下限 ${rule.limit}`] };
}

function combineGroupVerdicts(groupVerdicts) {
  const verdicts = groupVerdicts.map(item => item.verdict);
  const reasons = groupVerdicts.flatMap(item => item.reasons);
  if (verdicts.every(verdict => verdict === 'PASS')) return { verdict: 'PASS', reasons };
  if (verdicts.includes('FAIL')) return { verdict: 'FAIL', reasons };
  if (verdicts.includes('INDETERMINATE') || verdicts.includes('NO_EVIDENCE')) {
    return { verdict: 'INDETERMINATE', reasons: [...reasons, 'INSUFFICIENT_OR_DISJOINT_EVIDENCE'] };
  }
  return { verdict: 'INDETERMINATE', reasons };
}

// 批次对单个采购 profile 的各项要求判定（保留每个不连通小组的分组结论）。
export function evaluateLotRequirements(lotId, profile, lotEvidenceMap, rules, disagreements, config) {
  const evidence = lotEvidenceMap.get(lotId);
  const profileRules = rules.filter(rule => rule.profile === profile);
  const requirements = {};
  for (const rule of profileRules) {
    const groupResults = evidence.groups.map(group => {
      const base = { componentId: group.componentId, panels: group.panels, version: group.version, anchored: group.anchored };
      if (config.countMeasures.includes(rule.measure)) {
        return { ...base, ...countVerdict(group, rule) };
      }
      return { ...base, ...applyAnchorGate(base, measureVerdict(group.measures[rule.measure], rule, config)) };
    });
    const relatedDisagreements = disagreements
      .filter(item => item.lot === lotId && item.profiles.includes(profile) && item.measure === rule.measure)
      .map(item => `${item.code}(${item.blind},杯间差${item.range}>${item.maxDisagreement})`);
    const combined = combineGroupVerdicts(groupResults);
    if (relatedDisagreements.length && combined.verdict === 'PASS') {
      combined.verdict = 'INDETERMINATE';
    }
    requirements[rule.measure] = {
      limit: rule.limit,
      limitKind: rule.limit_kind,
      groupVerdicts: groupResults,
      combined,
      disagreementFlags: relatedDisagreements,
    };
  }
  return requirements;
}

// 报价档：只看订单 profile 对应的主评分项。
export function evaluateBand(order, lotEvidenceMap, config) {
  const measure = config.primaryMeasure[order.profile];
  const evidence = lotEvidenceMap.get(order.lot);
  const groupVerdicts = evidence.groups.map(group => {
    const groupMeasure = group.measures[measure];
    const base = { componentId: group.componentId, panels: group.panels, version: group.version, anchored: group.anchored };
    if (!groupMeasure || groupMeasure.status === 'NO_EVIDENCE') {
      return { ...base, verdict: 'NO_EVIDENCE', reasons: ['MEASURE_MASKED'] };
    }
    const { interval } = groupMeasure;
    let verdict;
    let reasons;
    if (interval.low >= order.band) {
      verdict = 'PASS';
      reasons = [];
    } else if (interval.high < order.band) {
      verdict = 'FAIL';
      reasons = [`BELOW_BAND:区间上界 ${interval.high} 低于报价档 ${order.band}`];
    } else {
      verdict = 'INDETERMINATE';
      reasons = [`BAND_STRADDLE:区间 [${interval.low}, ${interval.high}] 跨过报价档 ${order.band}，保持不可挑胜`];
    }
    return { ...base, ...applyAnchorGate(base, { verdict, reasons }) };
  });
  const combined = combineGroupVerdicts(groupVerdicts);
  return { measure, band: order.band, groupVerdicts, combined };
}

function checkLogistics(batch, order) {
  const reasons = [];
  if (batch.available_day > order.required_by) reasons.push(`LATE_AVAILABLE:available_day ${batch.available_day} 晚于 required_by ${order.required_by}`);
  if (batch.delivery_day > order.required_by) reasons.push(`LATE_DELIVERY:delivery_day ${batch.delivery_day} 晚于 required_by ${order.required_by}`);
  return { pass: reasons.length === 0, reasons };
}

export function buildLedger(batches, orders) {
  const ledger = new Map();
  for (const batch of batches) {
    ledger.set(batch.lot, {
      lot: batch.lot,
      supplier: batch.supplier,
      totalKg: batch.kg,
      committedKg: 0,
      allocatedOpenKg: 0,
      commitments: [],
      allocatableKg: batch.kg,
    });
  }
  // 先登记锁定承诺（reserved / issued），复核释放前任何其他订单都不能移用。
  const sorted = [...orders].sort((a, b) => a.order.localeCompare(b.order));
  for (const order of sorted.filter(item => item.state === 'reserved' || item.state === 'issued')) {
    const entry = ledger.get(order.lot);
    entry.committedKg += order.required_kg;
    entry.commitments.push({ order: order.order, kg: order.required_kg, state: order.state, deposit: order.deposit });
    entry.allocatableKg = Math.max(0, entry.totalKg - entry.committedKg);
  }
  // 开放订单按确定性顺序（订单号）尝试整单分配；不足量不自动零拆，余量保留给后续订单与复核。
  for (const order of sorted.filter(item => item.state === 'proposed')) {
    const entry = ledger.get(order.lot);
    if (!entry) continue;
    if (entry.allocatableKg >= order.required_kg) {
      order.__volumeVerdict = { verdict: 'FULL', allocatableNow: entry.allocatableKg, kg: order.required_kg };
      entry.allocatedOpenKg += order.required_kg;
      entry.allocatableKg -= order.required_kg;
    } else {
      order.__volumeVerdict = {
        verdict: 'INSUFFICIENT',
        allocatableNow: entry.allocatableKg,
        requestedKg: order.required_kg,
        note: '可分配余量不足整单，保留余量不自动零拆，待复核释放或改单',
      };
    }
  }
  return ledger;
}

function overallOrderVerdict(parts) {
  if (parts.logistics && !parts.logistics.pass) return { status: 'FAIL', code: 'LOGISTICS' };
  if (parts.volume?.verdict === 'INSUFFICIENT') return { status: 'ON_HOLD', code: 'VOLUME_INSUFFICIENT' };
  const band = parts.band.combined.verdict;
  if (band === 'FAIL') return { status: 'FAIL', code: 'BAND_NOT_MET' };
  const requirementFail = Object.values(parts.requirements).find(item => item.combined.verdict === 'FAIL');
  if (requirementFail) return { status: 'FAIL', code: 'REQUIREMENT_NOT_MET' };
  const pending = [
    band === 'INDETERMINATE' || band === 'NO_EVIDENCE' ? 'BAND_PENDING' : null,
    ...Object.entries(parts.requirements)
      .filter(([, item]) => item.combined.verdict === 'INDETERMINATE')
      .map(([measure]) => `REQUIREMENT_PENDING:${measure}`),
  ].filter(Boolean);
  if (pending.length) return { status: 'ON_HOLD', code: pending.join('|') };
  return { status: 'ELIGIBLE', code: 'ALL_CHECKS_PASS' };
}

export function evaluateOrders(tables, lotEvidenceMap, disagreements, config) {
  const ledger = buildLedger(tables.batches, tables.purchase);
  const results = [];
  for (const order of [...tables.purchase].sort((a, b) => a.order.localeCompare(b.order))) {
    const batch = tables.batches.find(item => item.lot === order.lot);
    const requirements = evaluateLotRequirements(order.lot, order.profile, lotEvidenceMap, tables.rules, disagreements, config);
    const band = evaluateBand(order, lotEvidenceMap, config);
    const logistics = checkLogistics(batch, order);
    const decision = overallOrderVerdict({ requirements, band, logistics, volume: order.__volumeVerdict });
    results.push({
      order: order.order,
      lot: order.lot,
      supplier: batch.supplier,
      profile: order.profile,
      state: order.state,
      requiredKg: order.required_kg,
      deposit: order.deposit,
      requiredBy: order.required_by,
      logistics,
      band,
      requirements,
      volume: order.__volumeVerdict ?? {
        verdict: 'COMMITTED',
        committedKg: order.required_kg,
        note: '定金承诺独立保留；复核释放批量前不可移用，不参与开放订单分配',
      },
      decision: order.state === 'reserved' || order.state === 'issued'
        ? { status: 'COMMITTED', code: 'DEPOSIT_LOCKED', underlying: decision }
        : decision,
    });
  }
  return { orders: results, ledger: [...ledger.values()] };
}
