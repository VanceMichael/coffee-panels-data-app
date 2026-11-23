// 复核规划：杯次预算有限，先比较「补参照让多个报价恢复可判」与「直补边缘批次」。
// 不在此处虚构补测分数；参照类选项只给结构性恢复说明，最终判定仍以录入的复判回报为准。

function splitSessions(raw) {
  return raw.split('|').filter(Boolean).sort();
}

// 结构投影：若某参照在目标小组各补入同版本盲样，当前图上哪些边会（重新）出现。
function projectedEdges(referenceIndex, edges, targetReference, targetSessions, versionGuess, cupRecords) {
  const recovered = [];
  const stillBroken = [];
  const targetSet = new Set(targetSessions);
  // 当前已经由该参照支撑的边。
  const existing = edges.filter(edge => edge.reference === targetReference);
  const existingKey = new Set(existing.map(edge => [edge.from, edge.to].sort().join('|')));
  // 该参照现存盲样覆盖的小组（按参照维度看，而非盲样编号）。
  const panelsWithRef = new Set();
  for (const item of referenceIndex.get(targetReference) ?? []) {
    if (item.state === 'withdrawn') continue;
    for (const panel of item.panels) panelsWithRef.add(panel);
  }
  const candidatePanels = new Set([...panelsWithRef, ...targetSet]);
  const panelList = [...candidatePanels].sort();
  for (let i = 0; i < panelList.length; i += 1) {
    for (let j = i + 1; j < panelList.length; j += 1) {
      const a = panelList[i];
      const b = panelList[j];
      const key = [`${a}@${versionGuess(a)}`, `${b}@${versionGuess(b)}`].sort().join('|');
      const sameVersion = versionGuess(a) === versionGuess(b);
      if (!sameVersion) {
        stillBroken.push({ pair: [a, b], reason: 'VERSION_MISMATCH:评分版本不同，资料未约定换算，补同参照也不可比' });
        continue;
      }
      if (existingKey.has(key)) continue;
      recovered.push({ pair: [a, b], projectedEdge: key });
    }
  }
  return { existing, recovered, stillBroken };
}

export function planRetest(tables, report, config) {
  const capacity = new Map(tables['lab-capacity'].map(row => [row.day, row.max_cups]));
  const referenceIndex = new Map((report.referenceIndex ?? []).map(item => [item.reference, item.items]));
  const currentOnHold = new Map();
  for (const order of report.orders) {
    const code = order.decision.status === 'COMMITTED' ? order.decision.underlying.code : order.decision.code;
    if (order.decision.status === 'ON_HOLD' || order.decision.status === 'COMMITTED' && String(code).includes('PENDING')) {
      currentOnHold.set(order.order, code);
    }
  }
  const options = tables.retest.map(option => {
    const sessions = splitSessions(option.sessions);
    const cap = capacity.get(option.available_day) ?? 0;
    const capacityOk = option.cups_required <= cap;
    const affectedOrders = [];
    for (const order of report.orders) {
      const lotEvidence = report.lotEvidence.find(item => item.lot === order.lot);
      const touchesLot = option.subject === order.lot;
      const touchesPanel = lotEvidence?.groups.some(group => group.panels.some(panel => sessions.includes(panel)));
      if (touchesLot || touchesPanel) affectedOrders.push(order.order);
    }
    let kind;
    let projection;
    if (tables.batches.some(batch => batch.lot === option.subject)) {
      kind = 'LOT_RETEST';
      const measure = config.primaryMeasure[report.orders.find(o => o.lot === option.subject)?.profile ?? 'aroma'] ?? 'aroma';
      projection = {
        effect: 'TIGHTEN_ONE_LOT',
        recovered: [],
        stillBroken: [],
        note: `直接增加 ${option.subject} 的观测杯数，仅收紧该批次 ${measure} 项的杯次标准误；共享偏差与连通性不变`,
        affectedOrders: [...new Set(affectedOrders)],
        fabrication: 'NO_FABRICATION:补测分数未录入前，不预测是否跨过报价档',
      };
    } else {
      kind = 'REFERENCE_RETEST';
      const versionGuess = panel => {
        const versions = new Set();
        for (const cup of report.cups.filter(c => c.panel === panel && c.usability === 'usable')) versions.add(cup.version);
        return versions.size === 1 ? [...versions][0] : null;
      };
      const projectionRaw = projectedEdges(referenceIndex, report.calibration.edges, option.subject, sessions, versionGuess, report.cups);
      // 只有证据小组落在本次补测小组集合内、且版本与补测小组现存量表一致时才可能恢复。
      const sessionVersions = new Map();
      for (const session of sessions) {
        const versions = new Set(report.cups.filter(c => c.panel === session && c.usability === 'usable').map(c => c.version));
        sessionVersions.set(session, versions);
      }
      const recoverableOrders = report.orders.filter(order => {
        const evidence = report.lotEvidence.find(item => item.lot === order.lot);
        return evidence?.groups.some(group =>
          !group.anchored &&
          group.panels.some(panel =>
            sessions.includes(panel) && sessionVersions.get(panel)?.has(group.version)));
      }).map(order => order.order);
      projection = {
        effect: 'RESTORE_COMPARABILITY',
        ...projectionRaw,
        affectedOrders: [...new Set([...affectedOrders, ...recoverableOrders])],
        fabrication: 'NO_FABRICATION:恢复连通是结构结论；锚定偏移与报价档判定须等复判回报录入后重算',
      };
    }
    return {
      option: option.option,
      availableDay: option.available_day,
      sessions,
      subject: option.subject,
      cupsRequired: option.cups_required,
      labCapacity: cap,
      kind,
      feasible: capacityOk,
      capacityReason: capacityOk ? null : `OVER_CAPACITY:需 ${option.cups_required} 杯，当日容量仅 ${cap} 杯`,
      projection,
    };
  });

  // 可选日程：按日容量做确定性装箱；同日冲突显式标出机会成本。
  const days = [...new Set(options.map(option => option.availableDay))].sort();
  const schedules = [];
  for (const day of days) {
    const dayOptions = options.filter(option => option.availableDay === day);
    const feasible = dayOptions.filter(option => option.feasible);
    const chosen = [];
    let remaining = capacity.get(day) ?? 0;
    // 参照类优先（一次恢复多报价），其次按 option 编号保证可重复。
    const ranked = [...feasible].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'REFERENCE_RETEST' ? -1 : 1;
      return a.option.localeCompare(b.option);
    });
    for (const option of ranked) {
      if (option.cupsRequired <= remaining) {
        chosen.push(option.option);
        remaining -= option.cupsRequired;
      }
    }
    const conflicts = feasible
      .filter(option => !chosen.includes(option.option))
      .map(option => ({
        option: option.option,
        sacrificedBecause: chosen,
        note: '同杯次预算下二选一：放弃该机会即承担对应订单继续挂起的成本',
      }));
    schedules.push({ day, capacity: capacity.get(day) ?? 0, chosen, conflicts, infeasible: dayOptions.filter(o => !o.feasible).map(o => o.option) });
  }

  const holdReasons = [...currentOnHold.entries()].map(([order, code]) => ({ order, reason: code }));
  return { onHoldAtAnalysis: holdReasons, options, schedules };
}
