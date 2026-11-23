// 溯源：任何采购查询都能追到它引用的具体杯次、评分版本、报价档与合同规则。
export function traceOrder(report, orderId, tables) {
  const order = report.orders.find(item => item.order === orderId);
  if (!order) throw new Error(`订单 ${orderId} 不存在`);
  const batch = tables.batches.find(item => item.lot === order.lot);
  const lot = report.lots.find(item => item.lot === order.lot);
  const evidence = report.lotEvidence.find(item => item.lot === order.lot);
  const cupChain = evidence.groups.flatMap(group =>
    Object.values(group.measures).flatMap(measure =>
      measure.observations?.map(observation => ({
        cup: observation.cup,
        panel: observation.panel,
        blind: report.cups.find(cup => cup.cup === observation.cup)?.blind,
        version: group.version,
        componentId: group.componentId,
        anchored: group.anchored,
      })) ?? []));
  const uniqCupChain = [...new Map(cupChain.map(item => [item.cup, item])).values()].sort((a, b) => a.cup.localeCompare(b.cup));
  const rulesUsed = tables.rules
    .filter(rule => rule.profile === order.profile)
    .map(rule => ({
      profile: rule.profile,
      measure: rule.measure,
      maxDisagreement: rule.max_disagreement,
      limit: rule.limit,
      limitKind: rule.limit_kind,
    }));
  return {
    order: order.order,
    quoteTier: {
      profile: order.profile,
      band: order.band.band,
      primaryMeasure: order.band.measure,
      bandVerdict: order.band.combined,
      perGroup: order.band.groupVerdicts,
    },
    target: {
      lot: order.lot,
      supplier: batch.supplier,
      expectedGrade: batch.grade_expected,
      requiredKg: order.requiredKg,
      requiredBy: order.requiredBy,
      logistics: order.logistics,
    },
    lotIdentity: lot,
    evidenceChain: uniqCupChain,
    blindKeyStates: report.blindKeys.filter(item => lot.samples.includes(item.blind)),
    contractRules: rulesUsed,
    decision: order.decision,
    volume: order.volume,
  };
}

export function traceLot(report, lotId) {
  const lot = report.lots.find(item => item.lot === lotId);
  if (!lot) throw new Error(`批次 ${lotId} 不存在`);
  const evidence = report.lotEvidence.find(item => item.lot === lotId);
  return {
    lot,
    evidence,
    referencedBy: report.orders.filter(order => order.lot === lotId).map(order => order.order),
  };
}
