import type { PricingRule, SourceRow } from './model.js';
import { PlytixError } from '../types.js';

/** Decimal rational arithmetic: no eval, binary rounding, percentages or unit conversion inferred. */
function fraction(value: string): [bigint, bigint] {
  if (!/^-?\d{1,12}(?:\.\d{1,6})?$/.test(value)) throw new PlytixError('Pricing amount must be a plain decimal without currency or grouping separators');
  const [whole, part = ''] = value.split('.');
  return [BigInt(whole + part), 10n ** BigInt(part.length)];
}
export function calculate(rule: PricingRule, row: SourceRow): number {
  let [n, d] = fraction(row.values[rule.source_column] ?? '');
  for (const operation of rule.operations) {
    const [on, od] = fraction(operation.operand);
    if (operation.op === 'multiply') { n *= on; d *= od; }
    else if (operation.op === 'divide') {
      if (!on) throw new PlytixError('Pricing calculation divides by zero');
      n *= od; d *= on;
    } else { n = n * od + (operation.op === 'add' ? on : -on) * d; d *= od; }
  }
  if (d < 0n) { n = -n; d = -d; }
  if (n < 0n) throw new PlytixError('Negative calculated prices are not supported');
  const scale = 10n ** BigInt(rule.decimals);
  const scaled = n * scale;
  const rounded = scaled / d + (2n * (scaled % d) >= d ? 1n : 0n);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new PlytixError('Calculated amount exceeds exact numeric range');
  const value = Number(rounded) / Number(scale);
  if (!Number.isFinite(value) || value < Number(rule.minimum) || value > Number(rule.maximum)) throw new PlytixError('Calculated amount is outside the reviewed rule range');
  return value;
}

export function withinChangeLimit(oldValue: number, newValue: number, percent: number): boolean {
  if (oldValue === 0) return newValue === 0;
  const exact = (value: number) => {
    const text = value.toFixed(6);
    if (Number(text) !== value) throw new PlytixError('Pricing comparisons support at most six decimal places');
    return fraction(text);
  };
  const [on, od] = exact(oldValue), [nn, nd] = exact(newValue), [pn, pd] = exact(percent);
  const difference = nn * od - on * nd;
  return (difference < 0n ? -difference : difference) * 100n * pd <= on * nd * pn;
}

/** Strict RFC-style comma CSV with quoted fields; no formula execution. */
export function parseCsv(csv: string): SourceRow[] {
  const records: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
  const text = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === '"') {
      if (field || closed) throw new PlytixError('Malformed CSV quoting');
      quoted = true;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(field); field = ''; closed = false;
      if (c !== ',') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        records.push(row); row = [];
      }
    } else {
      if (closed) throw new PlytixError('Malformed CSV quoting');
      field += c;
    }
  }
  if (quoted) throw new PlytixError('Unclosed CSV quote');
  if (field || row.length || closed) { row.push(field); records.push(row); }
  const headers = records.shift()?.map(value => value.trim()) ?? [];
  if (!headers.length || headers.some(value => !value || ['__proto__', 'constructor', 'prototype'].includes(value)) || new Set(headers).size !== headers.length) throw new PlytixError('CSV requires unique nonempty column headers');
  if (!records.length || records.length > 20) throw new PlytixError('Import must contain between 1 and 20 rows; split larger documents into reviewed batches');
  return records.map((cells, i) => {
    if (cells.length !== headers.length) throw new PlytixError('CSV row column count differs from header');
    return { source_ref: `CSV record ${i + 2}`, values: Object.fromEntries(headers.map((header, index) => [header, cells[index]])) };
  });
}
