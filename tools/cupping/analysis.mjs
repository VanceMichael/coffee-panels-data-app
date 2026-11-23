// 主编排：把身份层、校准层、判定层、复核规划串成可重复运行的报告。
// 相同输入（基础资料 + 事件目录 + 合同配置）必然产生相同输出，无时间戳、无随机数。
import { resolveBlindKeys, buildPanels, buildCupRecords, buildLotIdentity, buildReferenceIndex } from './identity.mjs';
import {
  buildNodes,
  buildEdges,
  connectedComponents,
  pooledSigmas,
  estimateOffsets,
  buildLotEvidence,
} from './calibration.mjs';
import { findDisagreements, evaluateOrders } from './rules.mjs';
import { planRetest } from './retest.mjs';

export function analyze(tables, config) {
  const blindMap = resolveBlindKeys(tables['blind-key'], config.analysisDay);
  const rawPanels = buildPanels(tables.cups);
  const panels = [...rawPanels.values()].map(panel => ({
    panel: panel.panel,
    judges: [...panel.judges].sort(),
    versions: [...panel.versions].sort(),
    cups: panel.cups.length,
  }));
  const cups = buildCupRecords(tables.cups, blindMap, config);
  const { lots: lotMap, samples } = buildLotIdentity(blindMap, cups);
  const referenceIndex = buildReferenceIndex(blindMap, cups);

  const nodes = buildNodes(cups);
  const edges = buildEdges(referenceIndex, cups);
  const components = connectedComponents(nodes, edges);
  const sigmas = pooledSigmas(cups, config);

  const offsetByComponent = new Map();
  const componentCalibration = components.map(component => {
    const { offsets, edgeChecks, reason } = estimateOffsets(component, edges, cups, config, sigmas);
    offsetByComponent.set(component.id, { offsets, edgeChecks });
    return {
      componentId: component.id,
      panels: component.panels,
      versions: component.versions,
      anchored: component.anchored,
      edgeReferences: [...new Set(component.edgeRefs)].sort(),
      reason: component.anchored ? null : reason,
      offsets: [...offsets.entries()].map(([node, info]) => ({
        node,
        offset: Number(info.offset.toFixed(6)),
        se: Number(info.se.toFixed(6)),
        anchorPath: info.path,
        anchored: info.anchored,
      })),
      edgeChecks,
    };
  });

  const lotEvidence = buildLotEvidence(lotMap, cups, components, offsetByComponent, sigmas, config);
  const disagreements = findDisagreements(cups, blindMap, tables.rules, config);
  const { orders, ledger } = evaluateOrders(tables, lotEvidence, disagreements, config);
  const baseReport = {
    schemaVersion: config.schemaVersion,
    configVersion: config.configVersion,
    analysisDay: config.analysisDay,
    intervalZ: config.intervalZ,
    panels,
    blindKeys: [...blindMap.values()].map(record => ({
      blind: record.blind,
      lot: record.lot,
      reference: record.reference,
      effectiveState: record.state,
      updatedDay: record.updatedDay,
      history: record.history,
    })),
    samples: [...samples.values()],
    lots: [...lotMap.values()].map(lot => ({
      lot: lot.lot,
      samples: lot.samples,
      cups: lot.cups,
      panels: lot.panels,
      versions: lot.versions,
    })),
    cups,
    referenceIndex: [...referenceIndex.entries()].map(([reference, items]) => ({ reference, items })),
    calibration: {
      sigmas,
      nodes: [...nodes.keys()].sort(),
      edges: edges.map(edge => ({
        reference: edge.reference,
        from: edge.from,
        to: edge.to,
        sharedBlinds: edge.sharedBlinds,
        rejected: edge.rejected,
        rejectReason: edge.rejectReason,
      })),
      components: componentCalibration,
    },
    lotEvidence: [...lotEvidence.values()],
    disagreements,
    orders,
    ledger,
  };
  const retestPlan = planRetest(tables, baseReport, config);
  return { ...baseReport, retestPlan };
}
