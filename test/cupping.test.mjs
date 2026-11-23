import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadTables, loadContract } from '../tools/cupping/ingest.mjs';
import { analyze } from '../tools/cupping/analysis.mjs';
import { compareReports } from '../tools/cupping/impact.mjs';
import { supplierView, labView, internalView } from '../tools/cupping/views.mjs';
import { traceOrder, traceLot } from '../tools/cupping/trace.mjs';
import { parseCsv, toCsv } from '../tools/cupping/csv.mjs';
import { resolveBlindKeys } from '../tools/cupping/identity.mjs';

const baseDir = join(process.cwd(), 'fixtures');
const configPath = join(process.cwd(), 'config', 'contract.json');

async function setup(eventsDir = null, overrides = {}) {
  const config = { ...(await loadContract(configPath)), ...overrides };
  // 测试默认不装载 events/ 示例目录，需要事件流的用例自行传入临时目录。
  const tables = await loadTables(baseDir, eventsDir);
  return { tables, config, report: analyze(tables, config) };
}

test('身份层：同一盲样多杯只是重复杯，不产生多个供货批', async () => {
  const { report } = await setup(null, { analysisDay: 12 });
  const l1 = report.lots.find(lot => lot.lot === 'L1');
  assert.deepEqual(l1.samples, ['X01']);
  assert.deepEqual(l1.cups, ['C1', 'C2']);
  const l3 = report.lots.find(lot => lot.lot === 'L3');
  assert.deepEqual(l3.samples.sort(), ['X05', 'X06']);
  assert.equal(new Set(report.lots.map(lot => lot.lot)).size, report.lots.length);
});

test('复判：withdrawn 在更新日后覆盖同盲样此前 valid', async () => {
  const { report } = await setup(null, { analysisDay: 12 });
  const x03 = report.blindKeys.find(item => item.blind === 'X03');
  assert.equal(x03.effectiveState, 'withdrawn');
  assert.ok(report.cups.find(cup => cup.cup === 'C4').usability === 'unusable');
  const earlier = await setup(null, { analysisDay: 8 });
  const x03Early = earlier.report.blindKeys.find(item => item.blind === 'X03');
  assert.equal(x03Early.effectiveState, 'valid');
  assert.equal(earlier.report.cups.find(cup => cup.cup === 'C4').usability, 'usable');
});

test('校准：不同评分版本即使共用参照也不可比，边被拒绝并保留原因', async () => {
  const { report } = await setup(null, { analysisDay: 8 });
  const rejected = report.calibration.edges.filter(edge => edge.rejected);
  assert.ok(rejected.some(edge => edge.reference === 'R3' && edge.rejectReason.includes('VERSION_MISMATCH')));
  const components = report.calibration.components;
  const cNode = components.find(c => c.panels.includes('C'));
  assert.deepEqual(cNode.versions, ['v2']);
  assert.equal(cNode.anchored, false);
});

test('校准：同版本 + 可信共同参照才连通，并给出小组偏移与边残差', async () => {
  const { report } = await setup(null, { analysisDay: 8 });
  const ab = report.calibration.components.find(c => c.panels.length === 2);
  assert.deepEqual(ab.panels, ['A', 'B']);
  assert.equal(ab.anchored, true);
  const bOffset = ab.offsets.find(o => o.node === 'B@v1');
  assert.equal(bOffset.anchored, true);
  assert.ok(bOffset.se > 0);
  assert.ok(ab.edgeChecks.every(check => Number.isFinite(check.residual)));
});

test('参照撤除：边缘相连的小组断开，未锚定结论不能跨组换算', async () => {
  const before = (await setup(null, { analysisDay: 8 })).report;
  const after = (await setup(null, { analysisDay: 12 })).report;
  assert.equal(before.calibration.components.some(c => c.anchored), true);
  assert.ok(after.calibration.components.every(c => c.anchored === false));
  const impact = compareReports(before, after);
  assert.deepEqual(impact.edgeChanges.removed, ['R1:A@v1|B@v1']);
  assert.deepEqual(impact.anchorsLost.flatMap(a => a.panels).sort(), ['A', 'B']);
  assert.ok(!impact.anchorsLost.some(a => a.panels.includes('C')), 'C 本来就未锚定，不计入锚丢失');
});

test('区间：共享偏差不随杯数下降，杯次噪声随杯数下降', async () => {
  const { report } = await setup(null, { analysisDay: 12 });
  const l1 = report.lotEvidence.find(e => e.lot === 'L1');
  const aroma = l1.groups[0].measures.aroma;
  assert.ok(aroma.seCommon >= 0.08 - 1e-9);
  const l2 = report.lotEvidence.find(e => e.lot === 'L2');
  const single = l2.groups[0].measures.aroma;
  assert.ok(single.seCup > aroma.seCup, '单杯的杯次标准误应大于双杯');
  assert.equal(aroma.seCommon, single.seCommon, '共享偏差与杯数无关');
});

test('区间跨过报价档保持 INDETERMINATE，不靠小数位挑胜', async () => {
  const { report } = await setup(null, { analysisDay: 12 });
  const p3 = report.orders.find(o => o.order === 'P3');
  assert.equal(p3.band.combined.verdict, 'INDETERMINATE');
  assert.ok(p3.band.combined.reasons.some(reason => reason.startsWith('BAND_STRADDLE')));
});

test('遮盖与欠缺：单项 NO_EVIDENCE 区别于整杯不可用', async () => {
  const { report } = await setup(null, { analysisDay: 12 });
  const l3 = report.lotEvidence.find(e => e.lot === 'L3');
  const groupB = l3.groups.find(g => g.panels.includes('B'));
  const c6 = report.cups.find(cup => cup.cup === 'C6');
  assert.equal(c6.usability, 'usable');
  assert.deepEqual(c6.missingMeasures, ['body']);
  assert.equal(groupB.measures.body.status, 'OK');
  assert.ok(groupB.measures.body.observations.some(o => o.missing));
  const withdrawnCup = report.cups.find(cup => cup.cup === 'C4');
  assert.equal(withdrawnCup.usability, 'unusable');
  assert.equal(withdrawnCup.unusableReason, 'REFERENCE_WITHDRAWN');
});

test('杯间差异超限只挂起对应项，其余项继续可判', async () => {
  const { report } = await setup(null, { analysisDay: 12 });
  const defectFlags = report.disagreements.filter(d => d.measure === 'defect' && d.lot === 'L3');
  assert.ok(defectFlags.length >= 1);
  assert.equal(defectFlags[0].scope, 'MEASURE');
  const p4 = report.orders.find(o => o.order === 'P4');
  // B 组确实观测到 defect=1，超出 upper 0，判 FAIL 同时保留杯间超限标记；同批次 body 项未被连坐。
  assert.equal(p4.requirements.defect.combined.verdict, 'FAIL');
  assert.ok(p4.requirements.defect.disagreementFlags.length >= 1);
  assert.equal(p4.requirements.body.groupVerdicts.length, 2);
});

test('不连通小组：L3 的 v1/v2 证据分组保留、禁止合并', async () => {
  const { report } = await setup(null, { analysisDay: 12 });
  const l3 = report.lotEvidence.find(e => e.lot === 'L3');
  assert.equal(l3.disjoint, true);
  assert.ok(l3.disjointReason.startsWith('DISJOINT_COMPONENTS'));
  assert.equal(l3.groups.length, 2);
  assert.deepEqual(l3.groups.map(g => g.version).sort(), ['v1', 'v2']);
});

test('承诺台账：定金批量独立锁定，开放订单不得重复占用', async () => {
  const { report } = await setup(null, { analysisDay: 12 });
  const l1 = report.ledger.find(l => l.lot === 'L1');
  assert.equal(l1.totalKg, 480);
  assert.equal(l1.committedKg, 300);
  assert.equal(l1.allocatableKg, 180);
  const l2 = report.ledger.find(l => l.lot === 'L2');
  assert.equal(350, l2.totalKg);
  assert.equal(0, l2.committedKg);
  // P3 整单 200kg 可分配，余量 150kg 保留；任何订单的整单分配都不得超过批次总量。
  assert.equal(150, l2.allocatableKg);
  const p3 = report.orders.find(o => o.order === 'P3');
  assert.equal(p3.volume.verdict, 'FULL');
  const p2 = report.orders.find(o => o.order === 'P2');
  assert.equal(p2.volume.verdict, 'INSUFFICIENT');
  assert.equal(p2.volume.allocatableNow, 180);
  const p1 = report.orders.find(o => o.order === 'P1');
  assert.equal(p1.decision.status, 'COMMITTED');
  for (const ledger of report.ledger) {
    assert.ok(ledger.allocatableKg >= 0);
    assert.equal(ledger.totalKg, ledger.committedKg + ledger.allocatedOpenKg + ledger.allocatableKg);
  }
  // P1 定金占用的 300kg 不得再次出现在任何开放订单的整单分配里。
  const l1OpenAllocation = report.orders
    .filter(o => o.lot === 'L1' && o.state === 'proposed' && o.volume.verdict === 'FULL')
    .reduce((sum, o) => sum + o.requiredKg, 0);
  assert.equal(l1OpenAllocation, 0);
});

test('未锚定闸门：无有效共同参照时采购判定挂起，原始数字仍保留', async () => {
  const { report } = await setup(null, { analysisDay: 12 });
  for (const order of report.orders.filter(o => o.state === 'proposed')) {
    if (order.decision.status === 'FAIL') continue;
    assert.equal(order.decision.status, 'ON_HOLD');
  }
  const l1 = report.lotEvidence.find(e => e.lot === 'L1');
  assert.ok(Number.isFinite(l1.groups[0].measures.aroma.point));
});

test('复测规划：参照补测可恢复多订单，批次直补只影响单批；容量超限被拒', async () => {
  const { report } = await setup(null, { analysisDay: 12 });
  const plan = report.retestPlan;
  const r01 = plan.options.find(o => o.option === 'R01');
  const r02 = plan.options.find(o => o.option === 'R02');
  const r03 = plan.options.find(o => o.option === 'R03');
  assert.equal(r01.kind, 'REFERENCE_RETEST');
  assert.ok(r01.projection.recovered.some(p => p.pair.join('|') === 'A|B'));
  assert.ok(r01.projection.affectedOrders.length > r02.projection.affectedOrders.length);
  assert.equal(r02.kind, 'LOT_RETEST');
  assert.equal(r03.feasible, false);
  assert.ok(r03.capacityReason.includes('OVER_CAPACITY'));
  assert.ok(r03.projection.stillBroken.some(p => p.reason.includes('VERSION_MISMATCH')));
  const day10 = plan.schedules.find(s => s.day === 10);
  assert.deepEqual(day10.chosen, ['R01']);
  assert.deepEqual(day10.conflicts.map(c => c.option), ['R02']);
});

test('影响视图：实验室拿到重出清单，买手区分暂缓与停止', async () => {
  const before = (await setup(null, { analysisDay: 8 })).report;
  const after = (await setup(null, { analysisDay: 12 })).report;
  const impact = compareReports(before, after);
  const lab = labView(after, impact);
  assert.ok(lab.reissues.mustReissue.some(item => item.order === 'P3'));
  assert.deepEqual(lab.reissues.labActions.map(a => a.panel).sort(), ['A', 'B']);
  const stop = impact.buyerActions.find(b => b.order === 'P4');
  assert.ok(stop.action.startsWith('STOP'));
  const suspend = impact.buyerActions.find(b => b.order === 'P3');
  assert.ok(suspend.action.startsWith('SUSPEND'));
});

test('角色视图：供货商只能看到自有批次，内部视图保留全量', async () => {
  const { report, tables } = await setup(null, { analysisDay: 12 });
  const f2 = supplierView(report, 'F2', tables.batches);
  assert.deepEqual(f2.lots.map(l => l.lot), ['L2']);
  assert.ok(!JSON.stringify(f2).includes('L1'));
  assert.ok(!JSON.stringify(f2).includes('offset'));
  const internal = internalView(report);
  assert.ok(internal.ledger.length === 3);
  assert.ok(internal.calibration.components.length === 3);
  const lab = labView(report);
  assert.ok(lab.withdrawnBlinds.includes('X03'));
});

test('溯源：采购查询追到杯次、评分版本、报价档与合同规则', async () => {
  const { report, tables } = await setup(null, { analysisDay: 12 });
  const trace = traceOrder(report, 'P3', tables);
  assert.deepEqual(trace.evidenceChain.map(c => c.cup), ['C5']);
  assert.equal(trace.evidenceChain[0].version, 'v1');
  assert.equal(trace.quoteTier.band, 8.5);
  assert.ok(trace.contractRules.some(rule => rule.measure === 'aroma' && rule.limit === 8));
  const lotTrace = traceLot(report, 'L3');
  assert.equal(lotTrace.referencedBy.includes('P4'), true);
  assert.throws(() => traceOrder(report, 'NOPE', tables), /不存在/);
});

test('事件流：新盲样经事件目录进入分析，基础资料不被改写', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cupping-events-'));
  await writeFile(join(dir, 'z1.blind-key.csv'), toCsv([
    { blind: 'Z01', lot: 'L2', reference: '', state: 'valid', updated_day: 11 },
  ], ['blind', 'lot', 'reference', 'state', 'updated_day']));
  await writeFile(join(dir, 'z1.cups.csv'), toCsv([
    { cup: 'CZ1', session: 'B', judge: 'J3', blind: 'Z01', score_version: 'v1', aroma: 8.9, body: 8.5, defect: 0, observed_day: 11 },
  ], ['cup', 'session', 'judge', 'blind', 'score_version', 'aroma', 'body', 'defect', 'observed_day']));
  const { report } = await setup(dir, { analysisDay: 12 });
  const l2 = report.lotEvidence.find(e => e.lot === 'L2');
  assert.ok(l2.groups[0].measures.aroma.observations.some(o => o.cup === 'CZ1'));
  const baseTables = await loadTables(baseDir, null);
  assert.ok(!baseTables.cups.some(cup => cup.cup === 'CZ1'));
  await rm(dir, { recursive: true, force: true });
});

test('确定性：相同输入两次运行的报告完全一致', async () => {
  const first = (await setup(null, { analysisDay: 12 })).report;
  const second = (await setup(null, { analysisDay: 12 })).report;
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('CSV 约定：空白与 - 读作 null，非法表头指出表名', () => {
  const rows = parseCsv('a,b\nx,\ny,-\n', ['a', 'b'], 't');
  assert.deepEqual(rows, [{ a: 'x', b: null }, { a: 'y', b: null }]);
  assert.throws(() => parseCsv('a,c\nx,1\n', ['a', 'b'], '订单'), /订单/);
});

test('盲样复判解析：同盲样多条记录以分析日内最新状态为准', () => {
  const rows = [
    { blind: 'B1', lot: null, reference: 'R9', state: 'valid', updated_day: 4, history: [] },
    { blind: 'B1', lot: null, reference: 'R9', state: 'withdrawn', updated_day: 9, history: [] },
  ];
  const map = resolveBlindKeys(rows, 8);
  assert.equal(map.get('B1').state, 'valid');
  const mapAfter = resolveBlindKeys(rows, 9);
  assert.equal(mapAfter.get('B1').state, 'withdrawn');
});
