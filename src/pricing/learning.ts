import { createHash } from 'node:crypto';
import { PricingMemory, type MemoryValue } from './memory.js';
import type { PricingChange, PricingRule } from './model.js';

export interface PricingSourceContext { supplier?: string; source_namespace?: string }
interface Source {
  source_name: string; source_sha256: string; source_context?: PricingSourceContext;
}
function sourceScope(source: Source): MemoryValue['scope'] {
  const supplier = source.source_context?.supplier?.trim();
  const explicit = source.source_context?.source_namespace?.trim();
  // Use the stable, explicitly supplied namespace across dated supplier lists.
  // Without one, scope conservatively to the document name rather than guessing.
  const name = source.source_name.length > 180
    ? `${source.source_name.slice(0, 155)}:${createHash('sha256').update(source.source_name).digest('hex').slice(0, 16)}`
    : source.source_name;
  return { ...(supplier ? { supplier } : {}), source_namespace: explicit ?? `document:${name}` };
}
const reference = (prefix: string, name: string) => `${prefix}: ${name}`.slice(0, 300);

/** Source headings and candidate family pointers only: no SKU/price/product values. */
export async function learnImport(memory: PricingMemory, input: Source & {
  sku_column: string; columns: string[]; family_suggestions: Array<{ family_id: string; name?: string | null }>;
}) {
  const scope = sourceScope(input), values: MemoryValue[] = [];
  for (const column of [...new Set(input.columns)].slice(0, 200)) {
    values.push({ kind: 'terminology', term: column, scope, attribute_labels: [],
      definition: column === input.sku_column
        ? 'Source identifier column used for exact catalog matching. Product identifiers and matches must be verified live.'
        : 'Observed source column heading. Its business meaning is not inferred; consult the document and current catalog before mapping it.' });
  }
  for (const family of input.family_suggestions.slice(0, 200)) {
    values.push({ kind: 'family_mapping', term: 'Source family mapping', scope: { ...scope, family_id: family.family_id }, attribute_labels: [],
      canonical_term: family.name?.slice(0, 200) || family.family_id,
      definition: `Candidate family ${family.family_id} observed during source matching. This is a suggestion, not a reviewed mapping; confirm current Plytix family membership and setup.` });
  }
  if (scope.supplier) values.push({ kind: 'supplier', term: scope.supplier, scope, attribute_labels: [],
    definition: 'Supplier explicitly supplied as source context. Confirm the current catalog supplier association before applying a pricing rule.' });
  return memory.record(values, { source: 'document', reference: reference('Import', input.source_name), source_sha256: input.source_sha256 }, 'proposed');
}

/** Successful planning evidence is advisory setup, never a substitute for a fresh plan. */
export async function learnPlan(memory: PricingMemory, input: Source & { changes: PricingChange[]; rules: PricingRule[] }) {
  const baseScope = sourceScope(input), values = new Map<string, MemoryValue>();
  for (const change of input.changes) {
    const rule = input.rules.find(candidate => candidate.id === change.rule_id);
    if (!rule) continue;
    const scope = { ...baseScope, family_id: change.family_id };
    const mapping: MemoryValue = { kind: 'family_mapping', term: 'Source family mapping', scope, attribute_labels: [],
      canonical_term: change.family_id,
      definition: `Family ${change.family_id} was explicitly mapped and passed pricing-plan validation. Recheck current Plytix membership, schema and inheritance before future updates.` };
    values.set(`family:${change.family_id}`, mapping);
    values.set(`attribute:${change.family_id}:${change.attribute}:${rule.source_column}`, {
      kind: 'attribute_setup', term: rule.source_column, canonical_term: change.attribute, scope, attribute_labels: [change.attribute],
      definition: `Source column mapped to ${change.attribute} by rule ${rule.id}; reported inheritance level ${change.inheritance_level}. Use current Plytix setup and the current rule before calculating or writing.` });
    values.set(`setup:${change.family_id}:${change.attribute}`, {
      kind: 'product_setup', term: change.attribute, scope, attribute_labels: [change.attribute],
      definition: `Pricing plans target the verified ${change.inheritance_level} owner of this attribute and preserve descendant overrides. Reinspect live ancestry, membership and overrides for every execution.` });
  }
  return memory.record([...values.values()], { source: 'document', reference: reference('Validated plan', input.source_name), source_sha256: input.source_sha256 });
}

/** Keep compact catalog schema pointers; omit options, prices, products and arbitrary metadata. */
export async function learnSchema(memory: PricingMemory, attributes: Array<{ id?: string; label?: string; name?: string; type_class?: string }>) {
  const values: MemoryValue[] = [];
  let ignored = 0;
  for (const attribute of attributes.slice(0, 200)) {
    if (!attribute.id || !attribute.label || !/^[a-zA-Z0-9_-]{1,160}$/.test(attribute.label) || !attribute.type_class) { ignored++; continue; }
    const id = attribute.id.slice(0, 200), type = attribute.type_class.slice(0, 200), name = (attribute.name ?? attribute.label).slice(0, 300);
    values.push({ kind: 'attribute_setup', term: attribute.label, canonical_term: attribute.label,
      scope: { source_namespace: 'plytix_schema' }, attribute_labels: [attribute.label],
      definition: `Plytix attribute ID ${id}, label ${attribute.label}, name ${name}, type ${type}. This is a dated structural observation; fetch current schema and applicable family settings before use.` });
  }
  const result = await memory.record(values, { source: 'plytix', reference: 'Catalog dictionary live attribute schema' });
  return { ...result, ignored: ignored + Math.max(0, attributes.length - 200) };
}
