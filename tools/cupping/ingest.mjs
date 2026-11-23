// 资料装载：只读基础资料（fixtures）+ 可选事件目录（新盲样 / 复判回报）。
// 事件文件沿用基础资料的表头约定，按文件名追加，基础资料永不被改写。
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCsv, toNumber } from './csv.mjs';

const TABLE_FIELDS = {
  batches: ['lot', 'supplier', 'grade_expected', 'kg', 'available_day', 'delivery_day'],
  cups: ['cup', 'session', 'judge', 'blind', 'score_version', 'aroma', 'body', 'defect', 'observed_day'],
  'blind-key': ['blind', 'lot', 'reference', 'state', 'updated_day'],
  purchase: ['order', 'lot', 'required_kg', 'required_by', 'profile', 'band', 'deposit', 'state'],
  retest: ['option', 'available_day', 'sessions', 'subject', 'cups_required'],
  rules: ['profile', 'measure', 'max_disagreement', 'limit', 'limit_kind'],
  'lab-capacity': ['day', 'max_cups'],
};

const NUMERIC = {
  batches: new Set(['kg', 'available_day', 'delivery_day']),
  cups: new Set(['aroma', 'body', 'defect', 'observed_day']),
  'blind-key': new Set(['updated_day']),
  purchase: new Set(['required_kg', 'required_by', 'band', 'deposit']),
  retest: new Set(['available_day', 'cups_required']),
  rules: new Set(['max_disagreement', 'limit']),
  'lab-capacity': new Set(['day', 'max_cups']),
};

async function loadOne(baseUrl, name, sourceLabel, eventsDir) {
  const url = new URL(`${name}.csv`, baseUrl);
  const rows = parseCsv(await readFile(url, 'utf8'), TABLE_FIELDS[name], name);
  for (const row of rows) {
    for (const field of NUMERIC[name]) row[field] = toNumber(row, field, name);
    row.__source = sourceLabel;
  }
  if (!eventsDir) return rows;
  let entries;
  try {
    entries = (await readdir(eventsDir)).filter(file => file.endsWith('.csv')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return rows;
    throw error;
  }
  for (const file of entries) {
    if (!file.endsWith(`.${name}.csv`) && !file.endsWith(`-${name}.csv`)) continue;
    const content = await readFile(join(eventsDir, file), 'utf8');
    const extra = parseCsv(content, TABLE_FIELDS[name], file);
    for (const row of extra) {
      for (const field of NUMERIC[name]) row[field] = toNumber(row, field, name);
      row.__source = file;
      rows.push(row);
    }
  }
  return rows;
}

export function checkLinks(tables) {
  const links = [
    ['cups', 'blind', 'blind-key', 'blind'],
    ['blind-key', 'lot', 'batches', 'lot'],
    ['purchase', 'lot', 'batches', 'lot'],
    ['purchase', 'profile', 'rules', 'profile'],
    ['retest', 'available_day', 'lab-capacity', 'day'],
  ];
  const errors = [];
  for (const [table, field, target, key] of links) {
    const keys = new Set(tables[target].map(row => row[key]));
    for (const row of tables[table]) {
      const value = row[field];
      if (value !== null && !keys.has(value)) {
        errors.push(`${table}.${field} 的 ${value} 在 ${target}.${key} 中无对应记录（来源 ${row.__source}）`);
      }
    }
  }
  if (errors.length) throw new Error(`资料引用校验失败：\n- ${errors.join('\n- ')}`);
}

export async function loadTables(baseDir, eventsDir = null) {
  const baseUrl = pathToFileURL(`${baseDir.replace(/\/?$/, '/')}`);
  const tables = {};
  for (const name of Object.keys(TABLE_FIELDS)) {
    tables[name] = await loadOne(baseUrl, name, `${name}.csv`, eventsDir);
  }
  checkLinks(tables);
  return tables;
}

export async function loadContract(configPath) {
  const url = pathToFileURL(configPath);
  return JSON.parse(await readFile(url, 'utf8'));
}
