import type { z } from 'zod';
import type { PlytixClient } from '../client.js';
import { PlytixError, type PlytixProduct } from '../types.js';
import { auditInput, type AuditInput } from './audit-model.js';
import { calculateWithTrace, calculationAttributes, withinChangeLimit } from './calculate.js';
import { applicableInstructions, evaluatePricingExclusions, guidanceDigest, readGuidance, type GuidanceDocument } from './guidance.js';
import { type PricingRule, type SourceRow } from './model.js';
import { provenanceDigest } from './provenance.js';
import { createPricingStore, type PricingStore } from './store.js';

const valueOf = (product: PlytixProduct, label: string): unknown =>
  Object.prototype.hasOwnProperty.call(product, `attributes.${label}`) ? product[`attributes.${label}`] : product.attributes?.[label];
function fail(message: string): never { throw new PlytixError(message); }
const canonicalName = (value: string, association: PricingRule['associations'][number]): string => {
  const aliases = association.aliases.filter(alias => alias.from.trim().toLowerCase() === value.trim().toLowerCase());
  if (aliases.length > 1) fail('Association alias is ambiguous');
  return (aliases[0]?.to ?? value).trim().toLowerCase();
};
type Mapping = AuditInput['mappings'][number];
type AuditComparison = {
  row_index: number; product_id: string; family_id: string; rule_id: string;
  status: 'matched' | 'difference' | 'protected' | 'blocked'; reason?: string;
  sku?: string; attribute?: string; current_value?: number; calculated_value?: number;
  difference?: number; currency?: string; unit?: string; source_ref?: string;
  source_rate?: string; source_column?: string;
  calculation_trace?: ReturnType<typeof calculateWithTrace>['trace'];
  inheritance_level?: string; owner_ancestry?: Record<string, unknown>; owner_override_markers?: PlytixProduct['overwritten_attributes'] | null;
  attribute_levels?: Record<string, string>; review_evidence?: Record<string, unknown>;
  owner_protections?: Array<{ id: string; reason: string }>;
  reported_descendant_count?: number; within_reviewed_change_limit?: boolean;
  evidence_digest?: string;
};

/** A non-persistent comparison service. Deliberately separate from StoredPlan:
 * no audit result can be selected or applied without fresh execution checks. */
export class PricingAuditService {
  constructor(private client: PlytixClient, private root = process.env.PLYTIX_PRICING_DIR,
    private storeFactory: (fingerprint: string, root?: string) => PricingStore = createPricingStore) {}

  async compare(raw: z.input<typeof auditInput>) {
    const input = auditInput.parse(raw);
    if (new Set(input.rules.map(rule => rule.id)).size !== input.rules.length) fail('Audit calculation rule IDs must be unique');
    const rules = new Map(input.rules.map(rule => [rule.id, rule]));
    const targets = input.mappings.map(mapping => `${mapping.product_id}/${rules.get(mapping.rule_id)?.target_attribute ?? mapping.rule_id}`);
    if (new Set(targets).size !== targets.length) fail('Audit mappings must contain each product/attribute owner once');
    await this.client.verifyKnowledgeAccess();
    const store = this.storeFactory(this.client.knowledgeFingerprint(), this.root);
    // This is the only store access. Unlike import/rule/schema discovery, this
    // path cannot trigger advisory observations or private draft creation.
    const guidance = await readGuidance(store);
    const products = new Map<string, PlytixProduct>();
    const families = new Map<string, Awaited<ReturnType<PlytixClient['getFamilyAllAttributes']>>>();
    const schemas = new Map<string, Awaited<ReturnType<PlytixClient['getAttributeById']>>>();
    const getProduct = async (id: string) => {
      if (!products.has(id)) {
        const product = (await this.client.getProduct(id)).data[0];
        if (!product || product.id !== id) fail('Current mapped product is unavailable');
        products.set(id, product);
      }
      return products.get(id)!;
    };
    const comparisons: AuditComparison[] = [];
    for (const mapping of input.mappings) {
      const rule = rules.get(mapping.rule_id), row = input.rows[mapping.row_index];
      try {
        if (!rule || !row) fail('Audit mapping refers to an unavailable source row or calculation rule');
        if (!families.has(mapping.family_id)) families.set(mapping.family_id, await this.client.getFamilyAllAttributes(mapping.family_id));
        const family = families.get(mapping.family_id)!;
        const product = await getProduct(mapping.product_id);
        const attributes = family.data.filter(attribute => attribute.label === rule.target_attribute && attribute.id);
        if (attributes.length !== 1) fail('Attribute inheritance configuration is missing or ambiguous');
        const attribute = attributes[0];
        if (!schemas.has(attribute.id!)) schemas.set(attribute.id!, await this.client.getAttributeById(attribute.id!));
        comparisons.push(await this.inspect(input, row, mapping, rule, product, guidance, family, schemas.get(attribute.id!)!, getProduct));
      } catch (error) {
        comparisons.push({ ...mapping, status: 'blocked', ...(rule ? { attribute: rule.target_attribute } : {}),
          ...(row ? { source_ref: row.source_ref } : {}),
          reason: error instanceof PlytixError ? error.message : 'Current pricing audit evidence could not be read or validated' });
      }
    }
    const observedAt = new Date().toISOString();
    return {
      kind: 'pricing_audit' as const, learning_mode: 'proposal_only' as const,
      persisted: false as const, executable: false as const, observed_at: observedAt,
      source: { source_name: input.source_name, source_sha256: input.source_sha256,
        extraction_sha256: provenanceDigest(input.rows), source_context: input.source_context ?? null },
      guidance: { revision: guidance.revision, digest: guidanceDigest(guidance),
        instructions: applicableInstructions(guidance, { family_ids: [...new Set(input.mappings.map(mapping => mapping.family_id))], source_context: input.source_context }) },
      summary: { owners: comparisons.length, matched: comparisons.filter(row => row.status === 'matched').length,
        differences: comparisons.filter(row => row.status === 'difference').length,
        protected: comparisons.filter(row => row.status === 'protected').length,
        blocked: comparisons.filter(row => row.status === 'blocked').length },
      comparisons, audit_digest: provenanceDigest({ input, comparisons, guidance_revision: guidance.revision, guidance_digest: guidanceDigest(guidance) }),
      coverage: 'explicit_mapped_owners_only' as const, descendant_impact: 'not_inspected' as const,
      next: 'Review owner comparisons and source interpretation. This audit does not establish descendant effects or execution eligibility. Any change requires a fresh pricing plan, complete inheritance-impact checks and exact approval. Save the returned evidence externally if a durable audit is needed.',
    };
  }

  private async inspect(input: AuditInput, row: SourceRow, mapping: Mapping, rule: PricingRule, product: PlytixProduct,
    guidance: GuidanceDocument, family: Awaited<ReturnType<PlytixClient['getFamilyAllAttributes']>>,
    schema: Awaited<ReturnType<PlytixClient['getAttributeById']>>, getProduct: (id: string) => Promise<PlytixProduct>): Promise<AuditComparison> {
    if ((rule.effective_from && Date.now() < Date.parse(rule.effective_from)) || (rule.effective_until && Date.now() > Date.parse(rule.effective_until))) fail('Pricing rule is outside its reviewed effective time window');
    if (!rule.family_ids.includes(mapping.family_id)) fail('Selected family is outside the calculation rule');
    if (product.sku !== row.values[input.sku_column]?.trim() || product.product_family_id !== mapping.family_id) fail('Product identity or family does not match the source mapping');
    const attribute = family.data.find(attribute => attribute.label === rule.target_attribute)!;
    if (!schema || schema.label !== rule.target_attribute || !['NumberAttribute', 'DecimalAttribute', 'IntegerAttribute'].includes(schema.type_class)) fail('Target must be a current supported numeric attribute');
    const level = attribute.attribute_level;
    let ancestry: Record<string, unknown>;
    if (level === 'variant_level') {
      if (product.product_type !== 'VARIANT' || !product._parent_id) fail('Variant-level price audit requires the configured Level 2 owner');
      const parent = await getProduct(product._parent_id!);
      if (parent.id === product.id || parent.product_type !== 'PARENT' || parent._parent_id || parent.product_family_id !== mapping.family_id) fail('Variant inheritance owner requires a verified root parent in the same family');
      ancestry = { parent_id: parent.id, parent_sku: parent.sku, parent_type: parent.product_type, family_id: parent.product_family_id };
    } else if (level === 'parent_level') {
      if (!['PARENT', 'SINGLE', 'STANDALONE'].includes(product.product_type ?? '') || product._parent_id) fail('Parent-level price audit requires the configured root owner');
      ancestry = { parent_id: null, owner_type: product.product_type, family_id: product.product_family_id };
    } else fail('Attribute inheritance level is off or unavailable');
    if (row.values[rule.currency_column] !== rule.currency || row.values[rule.unit_column] !== rule.unit) fail('Document currency or unit differs from the calculation rule');
    const required = [...new Set([...calculationAttributes(rule), ...rule.review_attributes, ...rule.associations.map(association => association.attribute),
      ...rule.conditions.filter(condition => condition.source === 'product').map(condition => condition.field)])];
    const evidence: Record<string, unknown> = {}, levels: Record<string, string> = { [rule.target_attribute]: level! };
    for (const label of required) {
      const candidates = family.data.filter(attribute => attribute.label === label);
      if (candidates.length !== 1 || !candidates[0].attribute_level) fail('A required audit attribute has missing or ambiguous family configuration');
      levels[label] = candidates[0].attribute_level!;
      evidence[label] = valueOf(product, label);
      if (evidence[label] === undefined || evidence[label] === null) fail('A required review or restriction attribute is unavailable');
    }
    for (const association of rule.associations) {
      const documentValue = row.values[association.column], current = valueOf(product, association.attribute);
      if (!documentValue || typeof current !== 'string' || canonicalName(documentValue, association) !== canonicalName(current, association)) fail('Brand, supplier or other association does not match the calculation rule');
    }
    for (const condition of rule.conditions) {
      const observed = condition.source === 'product' ? valueOf(product, condition.field) : row.values[condition.field];
      if (typeof observed !== 'string' && typeof observed !== 'number') fail('Restriction value is unavailable or unsupported');
      const included = condition.values.includes(String(observed));
      if (condition.operator === 'not_equals' ? included : !included) fail('Product or document restriction is not satisfied');
    }
    const current = valueOf(product, rule.target_attribute);
    if (typeof current !== 'number' || !Number.isFinite(current) || current < 0) fail('Existing numeric value is missing or invalid');
    if (rule.expected_existing_column && (!/^-?\d{1,12}(?:\.\d{1,6})?$/.test(row.values[rule.expected_existing_column] ?? '') || Number(row.values[rule.expected_existing_column]) !== current)) fail('Existing value does not match the document verification column');
    const calculation = calculateWithTrace(rule, row, product);
    if (schema.type_class === 'IntegerAttribute' && !Number.isInteger(calculation.value)) fail('Calculated amount is not an integer');
    const protection = evaluatePricingExclusions(guidance, product, rule.target_attribute);
    Object.assign(evidence, protection.evidence);
    const status = calculation.value === current ? 'matched' : protection.blocked.length ? 'protected' : 'difference';
    const comparison: AuditComparison = { ...mapping, status, sku: product.sku, attribute: rule.target_attribute,
      current_value: current, calculated_value: calculation.value, difference: Number((calculation.value - current).toFixed(6)),
      currency: rule.currency, unit: rule.unit, source_ref: row.source_ref, source_rate: row.values[rule.source_column], source_column: rule.source_column,
      calculation_trace: calculation.trace, inheritance_level: level!, owner_ancestry: ancestry, owner_override_markers: product.overwritten_attributes ?? null,
      attribute_levels: levels, review_evidence: evidence,
      owner_protections: protection.blocked, reported_descendant_count: product.num_variations,
      within_reviewed_change_limit: withinChangeLimit(current, calculation.value, rule.max_change_percent),
      ...(status === 'protected' ? { reason: 'An owner pricing protection prevents using this comparison as a proposed correction' } : {}) };
    comparison.evidence_digest = provenanceDigest({ comparison, family_configuration: family.data,
      target_schema: schema, source_row: row, calculation_rule: rule });
    return comparison;
  }
}
