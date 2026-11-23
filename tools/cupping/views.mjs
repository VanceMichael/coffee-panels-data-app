// 角色视图：同一套报告按使用方裁剪，避免对外泄露内部校准与其他供货商信息。
// - supplier：仅自有批次的评估状态与理由
// - lab：盲样、复判、待重出结论与容量/复测安排
// - internal：全量工作视图，复用到下一轮采购

export function supplierView(report, supplierId, batches) {
  const ownLots = new Set(batches.filter(batch => batch.supplier === supplierId).map(batch => batch.lot));
  return {
    view: 'supplier',
    supplier: supplierId,
    lots: report.lotEvidence
      .filter(item => ownLots.has(item.lot))
      .map(item => ({
        lot: item.lot,
        unusableCups: item.unusableCups,
        disjoint: item.disjoint,
        disjointReason: item.disjointReason,
        groups: item.groups.map(group => ({
          panels: group.panels,
          version: group.version,
          anchored: group.anchored,
          reasons: group.reasons,
          measureStatus: Object.fromEntries(Object.entries(group.measures).map(([measure, data]) => [
            measure,
            data.status === 'OK'
              ? { status: 'OK', n: data.n, interval: data.interval }
              : { status: data.status, reasons: data.reasons },
          ])),
          defects: group.defects,
        })),
      })),
    orders: report.orders
      .filter(order => ownLots.has(order.lot))
      .map(order => ({
        order: order.order,
        lot: order.lot,
        profile: order.profile,
        decision: order.decision,
        bandReasons: order.band.combined.reasons,
        requirementReasons: Object.fromEntries(Object.entries(order.requirements).map(([measure, item]) => [
          measure,
          { combined: item.combined, disagreementFlags: item.disagreementFlags },
        ])),
      })),
    redaction: '仅包含该供货商自有批次；不含其他批次、小组偏移数值与内部采购量分配',
  };
}

export function labView(report, impact = null) {
  return {
    view: 'lab',
    analysisDay: report.analysisDay,
    panels: report.panels,
    blindKeys: report.blindKeys.map(item => ({
      blind: item.blind,
      lot: item.lot,
      reference: item.reference,
      effectiveState: item.effectiveState,
      updatedDay: item.updatedDay,
    })),
    withdrawnBlinds: report.blindKeys.filter(item => item.effectiveState === 'withdrawn').map(item => item.blind),
    disagreements: report.disagreements,
    unusableCups: report.cups.filter(cup => cup.usability !== 'usable').map(cup => ({
      cup: cup.cup,
      panel: cup.panel,
      blind: cup.blind,
      reason: cup.unusableReason,
    })),
    calibration: {
      nodes: report.calibration.nodes,
      edges: report.calibration.edges,
      components: report.calibration.components.map(component => ({
        componentId: component.componentId,
        panels: component.panels,
        versions: component.versions,
        anchored: component.anchored,
        edgeReferences: component.edgeReferences,
        reason: component.reason,
        edgeChecks: component.edgeChecks,
      })),
    },
    retest: report.retestPlan,
    reissues: impact ? { mustReissue: impact.mustReissue, labActions: impact.labActions } : null,
  };
}

export function internalView(report, impact = null) {
  return {
    view: 'internal',
    generatedFrom: {
      schemaVersion: report.schemaVersion,
      configVersion: report.configVersion,
      analysisDay: report.analysisDay,
    },
    calibration: report.calibration,
    lotEvidence: report.lotEvidence,
    orders: report.orders,
    ledger: report.ledger,
    retestPlan: report.retestPlan,
    impact: impact ?? null,
  };
}
