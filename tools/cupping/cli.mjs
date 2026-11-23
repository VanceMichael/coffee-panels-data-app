#!/usr/bin/env node
// 杯测复核工具 CLI：仅依赖 Node.js 标准库，所有输出为确定性 JSON。
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadTables, loadContract } from './ingest.mjs';
import { analyze } from './analysis.mjs';
import { compareReports } from './impact.mjs';
import { supplierView, labView, internalView } from './views.mjs';
import { traceOrder, traceLot } from './trace.mjs';
import { toCsv } from './csv.mjs';

const parseArgs = argv => {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
};

const usage = `用法: node tools/cupping/cli.mjs <命令> [选项]
命令:
  analyze       运行完整分析，输出报告 JSON
  impact        对比两个分析日的报告（--before 报告A --after 报告B）
  trace-order   订单溯源（--order P1）
  trace-lot     批次溯源（--lot L1）
  view          角色视图（--role supplier|lab|internal，supplier 需 --supplier F1）
  add-blind     录入新盲样（写事件目录，不改基础资料）
  add-retest    录入复判回报（撤回盲样或新增杯次，写事件目录）
选项:
  --data      基础资料目录（默认 fixtures）
  --events    事件目录（默认 events）
  --config    合同配置（默认 config/contract.json）
  --day       覆盖分析日 analysisDay
  --out       输出 JSON 文件路径；缺省打印到标准输出
`;

async function emit(payload, out) {
  const text = JSON.stringify(payload, null, 2);
  if (out) {
    await writeFile(out, text + '\n', 'utf8');
    console.error(`已写入 ${out}`);
  } else {
    console.log(text);
  }
}

async function ensureEventsDir(eventsDir) {
  try {
    await access(eventsDir);
  } catch {
    await mkdir(eventsDir, { recursive: true });
  }
}

async function appendEvent(eventsDir, suffix, fields, row) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let name = `${stamp}.${suffix}.csv`;
  let counter = 1;
  while (true) {
    try {
      await access(join(eventsDir, name));
      counter += 1;
      name = `${stamp}-${counter}.${suffix}.csv`;
    } catch {
      break;
    }
  }
  const full = fields.map(field => (row[field] === undefined || row[field] === null ? '' : row[field]));
  await writeFile(join(eventsDir, name), toCsv([Object.fromEntries(fields.map((field, i) => [field, full[i]]))], fields), 'utf8');
  console.error(`事件已追加: ${join(eventsDir, name)}`);
}

async function buildReport(args) {
  const dataDir = resolve(args.data ?? 'fixtures');
  const eventsDir = args.events === false ? null : resolve(args.events ?? 'events');
  const config = await loadContract(resolve(args.config ?? 'config/contract.json'));
  if (args.day !== undefined && args.day !== true) config.analysisDay = Number(args.day);
  const tables = await loadTables(dataDir, eventsDir);
  return { report: analyze(tables, config), tables, config };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || ['-h', '--help', 'help'].includes(command)) {
    console.log(usage);
    return;
  }
  switch (command) {
    case 'analyze': {
      const { report } = await buildReport(args);
      await emit(report, args.out === true ? undefined : args.out);
      break;
    }
    case 'impact': {
      if (!args.before || !args.after) throw new Error('impact 需要 --before 与 --after 两个报告文件');
      const [before, after] = await Promise.all([
        readFile(args.before, 'utf8').then(JSON.parse),
        readFile(args.after, 'utf8').then(JSON.parse),
      ]);
      await emit(compareReports(before, after), args.out === true ? undefined : args.out);
      break;
    }
    case 'trace-order': {
      if (!args.order) throw new Error('trace-order 需要 --order');
      const { report, tables } = await buildReport(args);
      await emit(traceOrder(report, args.order, tables), args.out === true ? undefined : args.out);
      break;
    }
    case 'trace-lot': {
      if (!args.lot) throw new Error('trace-lot 需要 --lot');
      const { report } = await buildReport(args);
      await emit(traceLot(report, args.lot), args.out === true ? undefined : args.out);
      break;
    }
    case 'view': {
      const { report, tables } = await buildReport(args);
      let payload;
      if (args.role === 'supplier') {
        if (!args.supplier) throw new Error('supplier 视图需要 --supplier');
        payload = supplierView(report, args.supplier, tables.batches);
      } else if (args.role === 'lab') {
        payload = labView(report);
      } else if (args.role === 'internal') {
        payload = internalView(report);
      } else {
        throw new Error(`未知角色 ${args.role ?? ''}`);
      }
      await emit(payload, args.out === true ? undefined : args.out);
      break;
    }
    case 'add-blind': {
      for (const field of ['blind', 'day']) {
        if (!args[field]) throw new Error(`add-blind 需要 --${field}`);
      }
      const eventsDir = resolve(args.events ?? 'events');
      await ensureEventsDir(eventsDir);
      const blindFields = ['blind', 'lot', 'reference', 'state', 'updated_day'];
      await appendEvent(eventsDir, 'blind-key', blindFields, {
        blind: args.blind,
        lot: args.lot ?? '',
        reference: args.reference ?? '',
        state: args.state ?? 'valid',
        updated_day: args.day,
      });
      const cupFields = ['cup', 'session', 'judge', 'blind', 'score_version', 'aroma', 'body', 'defect', 'observed_day'];
      await appendEvent(eventsDir, 'cups', cupFields, {
        cup: args.cup,
        session: args.session,
        judge: args.judge ?? args.session,
        blind: args.blind,
        score_version: args.version ?? 'v1',
        aroma: args.aroma ?? '',
        body: args.body ?? '',
        defect: args.defect ?? '0',
        observed_day: args.day,
      });
      break;
    }
    case 'add-retest': {
      if (!args.blind || !args.day) throw new Error('add-retest 需要 --blind 与 --day');
      const eventsDir = resolve(args.events ?? 'events');
      await ensureEventsDir(eventsDir);
      const { report } = await buildReport({ ...args, events: eventsDir });
      const known = report.blindKeys.find(item => item.blind === args.blind);
      if (!known) throw new Error(`盲样 ${args.blind} 在基础资料与事件目录中不存在，无法复判`);
      const fields = ['blind', 'lot', 'reference', 'state', 'updated_day'];
      await appendEvent(eventsDir, 'blind-key', fields, {
        blind: args.blind,
        lot: known.lot ?? '',
        reference: known.reference ?? '',
        state: args.state ?? 'withdrawn',
        updated_day: args.day,
      });
      break;
    }
    default:
      throw new Error(`未知命令 ${command}\n${usage}`);
  }
}

main().catch(error => {
  console.error(`错误: ${error.message}`);
  process.exitCode = 1;
});
