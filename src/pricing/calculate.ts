import { PRICING_LIMITS, lengthUnit, type PricingChange, type PricingRule, type SourceRow } from './model.js';
import { PlytixError, type PlytixProduct } from '../types.js';
import { provenanceDigest } from './provenance.js';

/** Pure shared save/import policy. Only an unchanged rule already in the
 * destination may retain legacy fixed arithmetic as a reusable definition. */
export function assertReusableCostRules(incoming: PricingRule[], previous: PricingRule[] = []): void {
  for (const rule of incoming) {
    if (!/^supplier_[1-4]_cost$/.test(rule.target_attribute) || previous.some(old => provenanceDigest(old) === provenanceDigest(rule))) continue;
    if (!rule.full_item_cost) throw new PlytixError('New or changed reusable supplier-cost rules require a full_item_cost basis; keep fixed calculations in a private batch');
    if (rule.operations.some(operation => operation.role !== 'pricing_adjustment'))
      throw new PlytixError('Reusable full-item cost operations must declare pricing_adjustment; physical dimensions must come from current product attributes');
  }
}

/** Decimal rational arithmetic: no eval, binary rounding, percentages or unit conversion inferred. */
function fraction(value: string): [bigint, bigint] {
  if (!/^-?\d{1,12}(?:\.\d{1,6})?$/.test(value)) throw new PlytixError('Pricing amount must be a plain decimal without currency or grouping separators');
  const [whole, part = ''] = value.split('.');
  return [BigInt(whole + part), 10n ** BigInt(part.length)];
}
// Exact micrometres per unit. These are unit definitions, not raw-stock sizes.
const lengths = { mm: 1000n, cm: 10000n, m: 1000000n, in: 25400n, ft: 304800n } as const;
const attributeValue = (product: PlytixProduct, label: string) =>
  Object.prototype.hasOwnProperty.call(product, `attributes.${label}`) ? product[`attributes.${label}`] : product.attributes?.[label];

export function calculationAttributes(rule: PricingRule): string[] {
  return [...new Set(rule.full_item_cost?.dimensions.flatMap(binding => [binding.product_attribute,
    ...(binding.product_unit_attribute ? [binding.product_unit_attribute] : [])]) ?? [])];
}

function positiveDimension(value: unknown): [string, bigint, bigint] {
  if ((typeof value !== 'number' || !Number.isFinite(value)) && typeof value !== 'string')
    throw new PlytixError('Current full-item dimension is missing or invalid; clarify the catalog value before pricing');
  const text = String(value).trim();
  const [n, d] = fraction(text);
  if (n <= 0n) throw new PlytixError('Full-item dimensions must be positive');
  return [text, n, d];
}

export function calculateWithTrace(rule: PricingRule, row: SourceRow, product?: PlytixProduct): { value: number; trace?: PricingChange['calculation_trace'] } {
  let [n, d] = fraction(row.values[rule.source_column] ?? '');
  let trace: PricingChange['calculation_trace'];
  const basis = rule.full_item_cost;
  if (basis) {
    if (row.values[basis.price_unit_column] !== basis.price_unit)
      throw new PlytixError('Source price unit differs from the reviewed full-item basis');
    if (basis.dimensions.length && !product) throw new PlytixError('Current product dimensions are required for full-item pricing');
    let quantityN = 1n, quantityD = 1n;
    const dimensions: NonNullable<PricingChange['calculation_trace']>['dimensions'] = [];
    for (const binding of basis.dimensions) {
      const [value, dimensionN, dimensionD] = positiveDimension(attributeValue(product!, binding.product_attribute));
      const unit = lengthUnit.safeParse(binding.product_unit_attribute ? attributeValue(product!, binding.product_unit_attribute) : binding.product_unit);
      if (!unit.success) throw new PlytixError('Current full-item dimension unit is missing or unsupported');
      const dimension: typeof dimensions[number] = { product_attribute: binding.product_attribute, product_value: value,
        product_unit: unit.data, ...(binding.product_unit_attribute ? { product_unit_attribute: binding.product_unit_attribute } : {}) };
      if (binding.source) {
        dimension.source = { ...binding.source };
        const sourceValue = row.values[binding.source.value_column]?.trim() ?? '';
        const sourceUnit = row.values[binding.source.unit_column]?.trim() ?? '';
        if (sourceValue || sourceUnit) {
          if (!sourceValue || !sourceUnit) throw new PlytixError('Source full-item dimension and unit must be supplied together');
          const [sourceText, sourceN, sourceD] = positiveDimension(sourceValue);
          const parsedUnit = lengthUnit.safeParse(sourceUnit);
          if (!parsedUnit.success) throw new PlytixError('Source full-item dimension unit is unsupported');
          if (sourceN * lengths[parsedUnit.data] * dimensionD !== dimensionN * lengths[unit.data] * sourceD)
            throw new PlytixError('Source full-item dimension differs from the current catalog; resolve the mismatch before pricing');
          dimension.source = { ...binding.source, value: sourceText, unit: parsedUnit.data };
        }
      }
      dimensions.push(dimension);
      if (basis.price_basis !== 'item') {
        const priceLengthUnit = basis.price_unit.replace(/2$/, '') as keyof typeof lengths;
        quantityN *= dimensionN * lengths[unit.data];
        quantityD *= dimensionD * lengths[priceLengthUnit];
      }
    }
    n *= quantityN; d *= quantityD;
    // Keep the exact ratio in the review rather than rounding intermediate sizes.
    const gcd = (a: bigint, b: bigint): bigint => { while (b) [a, b] = [b, a % b]; return a; };
    const common = gcd(quantityN, quantityD);
    trace = { source_column: rule.source_column, source_price: row.values[rule.source_column], price_basis: basis.price_basis,
      price_unit: basis.price_unit, price_unit_column: basis.price_unit_column, dimensions,
      full_item_quantity: { numerator: String(quantityN / common), denominator: String(quantityD / common) },
      adjustments: rule.operations.map(operation => ({ ...operation })), decimals: rule.decimals, rounding: 'half_up', rounded_value: 0 };
  }
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
  if (trace) trace.rounded_value = value;
  return { value, ...(trace ? { trace } : {}) };
}

export function calculate(rule: PricingRule, row: SourceRow, product?: PlytixProduct): number {
  return calculateWithTrace(rule, row, product).value;
}

/** Compare each physical dimension, not just rounded prices or equal areas. */
export function sameFullItemBasis(left: PricingChange['calculation_trace'], right: PricingChange['calculation_trace']): boolean {
  if (!left || !right || left.dimensions.length !== right.dimensions.length) return false;
  return left.dimensions.every((dimension, index) => {
    const other = right.dimensions[index];
    const [ln, ld] = fraction(dimension.product_value), [rn, rd] = fraction(other.product_value);
    return dimension.product_attribute === other.product_attribute && ln * lengths[dimension.product_unit] * rd === rn * lengths[other.product_unit] * ld;
  });
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
  if (!records.length || records.length > PRICING_LIMITS.import_rows) throw new PlytixError(`Import must contain between 1 and ${PRICING_LIMITS.import_rows} rows; split larger documents into reviewed batches`);
  return records.map((cells, i) => {
    if (cells.length !== headers.length) throw new PlytixError('CSV row column count differs from header');
    return { source_ref: `CSV record ${i + 2}`, values: Object.fromEntries(headers.map((header, index) => [header, cells[index]])) };
  });
}
