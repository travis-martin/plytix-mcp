import { createHash } from 'node:crypto';
import type { PlytixClient } from '../client.js';
import { PlytixError, type PlytixProduct } from '../types.js';
import type { PricingChange, PricingRule } from './model.js';
import type { GuidanceDocument } from './guidance.js';

export const valueOf = (p: PlytixProduct, label: string): unknown =>
  Object.prototype.hasOwnProperty.call(p, `attributes.${label}`) ? p[`attributes.${label}`] : p.attributes?.[label];
export const stockLabels = [
  'material_id', 'price_calculation_method', 'primary_supplier', 'raw_material_width',
  'raw_material_length', 'raw_material_weight_oz', 'specific_gravity', 'shape',
  'color_name', 'grade', 'series', 'actual_diameter_decimal', 'actual_thickness_decimal',
  ...[1, 2, 3, 4].flatMap(n => [`supplier_${n}_name`, `supplier_${n}_mpn`, `supplier_${n}_cost`]),
];
const identityLabels = ['shape', 'color_name', 'grade', 'series', 'actual_diameter_decimal', 'actual_thickness_decimal'];
const structure = ['sku', 'product_family_id', 'product_type', '_parent_id', 'num_variations', 'overwritten_attributes'];
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const normalize = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';

/** Grouping is a consistency check, never permission to write additional owners. */
export function materialGroup(product: PlytixProduct, rule: Pick<PricingRule, 'target_attribute' | 'associations' | 'currency' | 'unit'>): PricingChange['material_group'] {
  const slot = /^supplier_([1-4])_cost$/.exec(rule.target_attribute)?.[1];
  const supplierAttribute = slot ? `supplier_${slot}_name` : rule.associations.find(a => a.kind === 'supplier')?.attribute;
  const supplier = supplierAttribute ? normalize(valueOf(product, supplierAttribute)) : '';
  const material = valueOf(product, 'material_id');
  const mpnAttribute = slot ? `supplier_${slot}_mpn` : undefined;
  const mpn = mpnAttribute ? valueOf(product, mpnAttribute) : undefined;
  const identifier = typeof material === 'string' && material.trim() ? material.trim() : typeof mpn === 'string' ? mpn.trim() : '';
  if (!supplier || !identifier) return undefined;
  const identity: Record<string, unknown> = {};
  for (const label of identityLabels) identity[label] = valueOf(product, label) ?? null;
  const method = valueOf(product, 'price_calculation_method');
  identity.price_calculation_method = method ?? null;
  // Include both stock dimensions when present; never equate different full-item costs.
  identity.raw_material_length = valueOf(product, 'raw_material_length') ?? null;
  identity.raw_material_width = valueOf(product, 'raw_material_width') ?? null;
  identity.currency = rule.currency; identity.unit = rule.unit;
  const identifier_attribute = typeof material === 'string' && material.trim() ? 'material_id' : mpnAttribute!;
  const key = createHash('sha256').update(JSON.stringify([product.product_family_id, rule.target_attribute, supplier, identifier_attribute, identifier, identity])).digest('hex');
  return { key, scope: 'family', supplier, identifier, identifier_attribute, identity };
}

/** One bounded family read per page/field block. Unknown total_count semantics
 * cannot cause either premature completion or a full-catalog pagination loop. */
export class PricingSnapshot {
  readonly products = new Map<string, PlytixProduct>();
  readonly families = new Map<string, Awaited<ReturnType<PlytixClient['getFamilyAllAttributes']>>>();
  readonly schemas = new Map<string, Awaited<ReturnType<PlytixClient['getAttributeById']>>>();
  readonly fields = new Set<string>();
  searchRequests = 0;
  constructor(private client: PlytixClient) {}

  async load(familyIds: string[], rules: PricingRule[], guidance: GuidanceDocument) {
    for (const id of new Set(familyIds)) {
      const family = await this.client.getFamilyAllAttributes(id); this.families.set(id, family);
      const known = new Set(family.data.map(a => a.label));
      const labels = new Set([
        ...stockLabels.filter(label => known.has(label)),
        ...rules.filter(r => r.family_ids.includes(id)).flatMap(r => [r.target_attribute, ...r.review_attributes,
          ...r.associations.map(a => a.attribute), ...r.conditions.filter(c => c.source === 'product').map(c => c.field)]),
        ...guidance.exclusions.filter(e => e.status === 'active' && e.family_ids.includes(id)).flatMap(e => e.all.map(c => c.attribute)),
      ]);
      for (const label of labels) this.fields.add(label);
      for (const r of rules.filter(r => r.family_ids.includes(id))) {
        const attribute = family.data.find(a => a.label === r.target_attribute);
        if (attribute?.id && !this.schemas.has(attribute.id)) this.schemas.set(attribute.id, await this.client.getAttributeById(attribute.id));
      }
      const chunks = [...labels];
      let expectedIds: Set<string> | undefined;
      for (let fieldOffset = 0; fieldOffset < Math.max(1, chunks.length); fieldOffset += 44) {
        const seen = new Set<string>(); let complete = false;
        for (let page = 1; page <= 100; page++) {
          const response = await this.client.searchProducts({ filters: [[{ field: 'product_family_id', operator: 'eq', value: id }]],
            attributes: [...structure, ...chunks.slice(fieldOffset, fieldOffset + 44).map(a => `attributes.${a}`)],
            pagination: { page, page_size: 100, order: 'sku' } });
          this.searchRequests++;
          if (response.meta?.complete === false || (response.pagination?.page !== undefined && response.pagination.page !== page)) throw new PlytixError('Incomplete pricing family snapshot');
          for (const record of response.data) {
            if (!record.id || record.product_family_id !== id || seen.has(record.id)) throw new PlytixError('Pricing snapshot contains duplicate or out-of-scope products');
            seen.add(record.id);
            const previous = this.products.get(record.id);
            if (previous && structure.some(field => !same(previous[field], record[field]))) throw new PlytixError('Product structure changed during paginated snapshot');
            const attributes = { ...previous?.attributes, ...record.attributes };
            for (const label of chunks.slice(fieldOffset, fieldOffset + 44)) attributes[label] = valueOf(record, label) ?? null;
            this.products.set(record.id, { ...previous, ...record, attributes });
          }
          // A short page closes this bounded query. Explicit page/total fields,
          // unlike catalog-wide total_count, must agree when supplied.
          if (response.data.length < 100) {
            if ((response.pagination?.pages !== undefined && response.pagination.pages > page) ||
                (response.pagination?.total !== undefined && response.pagination.total !== seen.size)) throw new PlytixError('Truncated pricing family snapshot');
            complete = true; break;
          }
        }
        if (!complete) throw new PlytixError('Pricing family exceeds the bounded snapshot limit');
        if (expectedIds && (seen.size !== expectedIds.size || [...seen].some(id => !expectedIds!.has(id)))) throw new PlytixError('Product membership changed during snapshot');
        expectedIds = seen;
      }
    }
    return this;
  }

  product(id: string) { return this.products.get(id); }
  children(id: string) { return [...this.products.values()].filter(p => p._parent_id === id); }
  result(id: string) { const p = this.product(id); return { data: p ? [p] : [] }; }
  variants(id: string) { return { data: this.children(id) }; }
}
