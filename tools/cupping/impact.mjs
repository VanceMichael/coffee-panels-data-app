// 复判影响：参照被复判撤除可能让原本边缘相连的小组断开。
// 对比两个时点的报告，产出实验室必须重出的结论、买手须暂缓/可继续的报单。

export function compareReports(before, after) {
  const edgesBefore = new Set(before.calibration.edges.map(edge => `${edge.reference}:${edge.from}|${edge.to}`));
  const edgesAfter = new Set(after.calibration.edges.map(edge => `${edge.reference}:${edge.from}|${edge.to}`));
  const removedEdges = [...edgesBefore].filter(edge => !edgesAfter.has(edge));
  const addedEdges = [...edgesAfter].filter(edge => !edgesBefore.has(edge));

  const beforeAnchoredPanels = new Set();
  for (const component of before.calibration.components.filter(c => c.anchored)) {
    for (const panel of component.panels) beforeAnchoredPanels.add(panel);
  }
  const anchorsLost = after.calibration.components
    .filter(component => !component.anchored)
    .flatMap(component => component.panels
      .filter(panel => beforeAnchoredPanels.has(panel))
      .map(panel => ({
        componentId: component.componentId,
        panels: [panel],
        versions: component.versions,
        reason: 'ANCHOR_LOST:该小组原有有效共同参照，撤除后区间只能在其原始量表内保留',
      })));

  const beforeMap = new Map(before.orders.map(order => [order.order, order]));

  const orderChanges = [];
  for (const order of after.orders) {
    const previous = beforeMap.get(order.order);
    if (!previous) continue;
    const beforeStatus = previous.decision.status;
    const afterStatus = order.decision.status;
    const beforeCode = beforeStatus === 'COMMITTED' ? previous.decision.underlying.code : previous.decision.code;
    const afterCode = afterStatus === 'COMMITTED' ? order.decision.underlying.code : order.decision.code;
    if (beforeStatus !== afterStatus || beforeCode !== afterCode) {
      orderChanges.push({
        order: order.order,
        lot: order.lot,
        supplier: order.supplier,
        from: { status: beforeStatus, code: beforeCode },
        to: { status: afterStatus, code: afterCode },
      });
    }
  }

  const mustReissue = [];
  const lostPanelSet = new Set(anchorsLost.flatMap(item => item.panels));
  for (const order of after.orders) {
    const evidence = after.lotEvidence.find(item => item.lot === order.lot);
    const touchesLostAnchor = evidence?.groups.some(group => group.panels.some(panel => lostPanelSet.has(panel)));
    if (touchesLostAnchor) {
      mustReissue.push({
        order: order.order,
        lot: order.lot,
        reason: 'REISSUE_REQUIRED:原结论建立在已断开的跨组校准上，必须以新分量重出',
      });
    }
  }

  const buyerActions = after.orders.map(order => {
    const previous = beforeMap.get(order.order);
    const status = order.decision.status;
    const code = status === 'COMMITTED' ? order.decision.underlying.code : order.decision.code;
    let action;
    if (status === 'FAIL') {
      action = 'STOP:不满足采购规则，停止该报单';
    } else if (status === 'ON_HOLD' || String(code).includes('PENDING') || mustReissue.some(item => item.order === order.order)) {
      action = 'SUSPEND:暂缓签发，等待参照恢复或补测；已付定金的承诺继续独立占量，不释放';
    } else if (status === 'ELIGIBLE') {
      action = 'PROCEED:可按报价档继续采购';
    } else if (status === 'COMMITTED') {
      action = 'KEEP_COMMITMENT:定金承诺保留，复核释放批量前不可移用';
    } else {
      action = 'REVIEW:按部分结论人工复核';
    }
    return {
      order: order.order,
      lot: order.lot,
      supplier: order.supplier,
      state: order.state,
      status,
      code,
      changed: previous ? previous.decision.status !== status : true,
      action,
    };
  });

  const labActions = anchorsLost.map(item => ({
    panel: item.panels[0],
    component: item.componentId,
    action: 'REISSUE_LAB_REPORT:该小组参与的跨组校准表与批次结论须重出；同组原始杯次记录仍可作为单组证据保留',
  }));

  return {
    edgeChanges: { removed: removedEdges, added: addedEdges },
    anchorsLost,
    componentSummary: {
      before: before.calibration.components.map(c => ({ componentId: c.componentId, panels: c.panels, anchored: c.anchored })),
      after: after.calibration.components.map(c => ({ componentId: c.componentId, panels: c.panels, anchored: c.anchored })),
    },
    mustReissue: [...new Map(mustReissue.map(item => [item.order, item])).values()],
    orderChanges,
    buyerActions,
    labActions,
  };
}
