// 严格 CSV 读写：约定 UTF-8、逗号分隔、无引号、无内嵌换行。
// 空白单元格读作 null（覆核不可读）；关系值 '-' 同样读作 null（不适用）。

export function parseCsv(content, fields, table) {
  const lines = content.replace(/^﻿/, '').trimEnd().split(/\r?\n/);
  const header = lines.shift().split(',');
  if (header.length !== fields.length || header.some((field, i) => field !== fields[i])) {
    throw new Error(`${table} 的表头与格式约定不一致：期望 ${fields.join(',')}，实际 ${header.join(',')}`);
  }
  return lines.map((line, index) => {
    const cells = line.split(',');
    if (cells.length !== fields.length || line.includes('"')) {
      throw new Error(`${table} 第 ${index + 2} 行不是约定的字段格式`);
    }
    return Object.fromEntries(fields.map((field, i) => [field, cells[i] === '' || cells[i] === '-' ? null : cells[i]]));
  });
}

export function toCsv(rows, fields) {
  const escape = value => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    if (/[",\n]/.test(text)) throw new Error(`值 ${text} 超出无引号 CSV 约定`);
    return text;
  };
  const body = rows.map(row => fields.map(field => escape(row[field])).join(','));
  return [fields.join(','), ...body].join('\n') + '\n';
}

// 数字列转换；空白保持 null。
export function toNumber(row, field, table) {
  const raw = row[field];
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${table}.${field} 的值 ${raw} 不是数字`);
  return value;
}
