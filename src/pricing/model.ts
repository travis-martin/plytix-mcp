import { z } from 'zod';
import { recordProvenanceSchema, reviewMetadataSchema } from './provenance.js';
import { revisionContextSchema, versionHistoryPointer } from './version-history.js';

export const PRICING_LIMITS = { import_rows: 100, plan_changes: 100, review_lines: 1000, search_page_size: 100, search_pages: 10 } as const;
export const label = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
export const learningMode = z.enum(['automatic', 'proposal_only']);
export type LearningMode = z.infer<typeof learningMode>;
const text = z.string().trim().min(1).max(200);
export const decimal = z.string().regex(/^-?\d{1,12}(?:\.\d{1,6})?$/);
// Supplier workbook caches can retain more precision than displayed quotes.
// Keep that input exact; executable output/adjustment limits remain unchanged.
export const sourceDecimal = z.string().regex(/^-?\d{1,12}(?:\.\d{1,18})?$/);
export const lengthUnit = z.enum(['mm', 'cm', 'm', 'in', 'ft']);
export const priceUnit = z.enum(['item', 'mm', 'cm', 'm', 'in', 'ft', 'mm2', 'cm2', 'm2', 'in2', 'ft2']);
const calculationOperation = z.object({ op: z.enum(['multiply', 'divide', 'add', 'subtract']), operand: decimal,
  role: z.literal('pricing_adjustment').optional() }).strict();
const dimensionBinding = z.object({
  product_attribute: label,
  // A fixed unit is reviewed schema metadata, never a fixed physical dimension.
  product_unit: lengthUnit.optional(), product_unit_attribute: label.optional(),
  source: z.object({ value_column: text, unit_column: text }).strict().optional(),
}).strict().refine(binding => Boolean(binding.product_unit) !== Boolean(binding.product_unit_attribute),
  'Choose a reviewed catalog unit or a current product unit attribute');
export const fullItemCostSchema = z.object({
  price_basis: z.enum(['item', 'length', 'area']),
  price_unit: priceUnit, price_unit_column: text,
  dimensions: z.array(dimensionBinding).max(2),
}).strict().superRefine((basis, ctx) => {
  const count = basis.dimensions.length;
  if ((basis.price_basis === 'length' && count !== 1) || (basis.price_basis === 'area' && count !== 2))
    ctx.addIssue({ code: 'custom', message: 'Length pricing requires one live dimension; area pricing requires two', path: ['dimensions'] });
  if (new Set(basis.dimensions.map(dimension => dimension.product_attribute)).size !== count)
    ctx.addIssue({ code: 'custom', message: 'Full-item dimensions must use distinct product attributes', path: ['dimensions'] });
  const expected = basis.price_basis === 'item' ? basis.price_unit === 'item'
    : basis.price_basis === 'area' ? basis.price_unit.endsWith('2') : lengthUnit.safeParse(basis.price_unit).success;
  if (!expected) ctx.addIssue({ code: 'custom', message: 'Source price unit does not match the reviewed price basis', path: ['price_unit'] });
});
export const calculationTraceSchema = z.object({
  source_column: text, source_price: sourceDecimal, price_basis: z.enum(['item', 'length', 'area']), price_unit: priceUnit,
  price_unit_column: text,
  dimensions: z.array(z.object({
    product_attribute: label, product_value: decimal, product_unit: lengthUnit,
    product_unit_attribute: label.optional(),
    source: z.object({ value_column: text, unit_column: text, value: decimal.optional(), unit: lengthUnit.optional() }).strict().optional(),
  }).strict()).max(2),
  full_item_quantity: z.object({ numerator: z.string().regex(/^\d+$/), denominator: z.string().regex(/^[1-9]\d*$/) }).strict(),
  adjustments: z.array(calculationOperation).max(12),
  decimals: z.number().int().min(0).max(6), rounding: z.literal('half_up'),
  rounded_value: z.number().finite(),
}).strict();
export const sourceRow = z.object({
  source_ref: z.string().min(1).max(300),
  values: z.record(z.string().max(200), z.string().max(2000)),
}).strict();
export const importInput = z.object({
  source_name: text,
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sku_column: text,
  source_context: z.object({ supplier: text.optional(), source_namespace: text.optional() }).strict().optional(),
  learning_mode: learningMode.optional(),
  csv: z.string().min(1).max(64000).optional(),
  rows: z.array(sourceRow).min(1).max(PRICING_LIMITS.import_rows).optional(),
}).strict();
export const ruleSchema = z.object({
  id: label, name: text, status: z.enum(['proposed', 'confirmed']),
  evidence: z.string().min(1).max(1500),
  effective_from: z.string().datetime({ offset: true }).optional(),
  effective_until: z.string().datetime({ offset: true }).optional(),
  family_ids: z.array(text).min(1).max(20),
  target_attribute: label, source_column: text,
  currency: z.string().regex(/^[A-Z]{3}$/), currency_column: text,
  unit: text, unit_column: text,
  operations: z.array(calculationOperation).max(12),
  full_item_cost: fullItemCostSchema.optional(),
  decimals: z.number().int().min(0).max(6).default(2),
  minimum: decimal.default('0'), maximum: decimal,
  max_change_percent: z.number().finite().min(0).max(10000),
  expected_existing_column: text.optional(),
  review_attributes: z.array(label).max(20).default([]),
  associations: z.array(z.object({
    kind: z.enum(['brand', 'supplier', 'other']), column: text, attribute: label,
    aliases: z.array(z.object({ from: text, to: text }).strict()).max(100).default([]),
  }).strict()).max(10).default([]),
  conditions: z.array(z.object({
    source: z.enum(['product', 'document']), field: text,
    operator: z.enum(['equals', 'not_equals', 'in']), values: z.array(text).min(1).max(50),
  }).strict()).max(20).default([]),
}).strict();
export type PricingRule = z.infer<typeof ruleSchema>;
export type SourceRow = z.infer<typeof sourceRow>;
export const mappingSchema = z.object({
  row_index: z.number().int().min(0).max(PRICING_LIMITS.import_rows - 1), product_id: text, family_id: text,
  proposed_value: decimal.optional(), review_note: z.string().trim().min(1).max(2000).optional(),
}).strict();
export const planInput = z.object({
  import_id: z.string().uuid(), rule_ids: z.array(label).max(10).default([]),
  learning_mode: learningMode.optional(),
  // Private, one-run calculation definitions. Approval covers the resulting exact
  // changes; these definitions are never promoted to the shared rule store.
  batch_rules: z.array(ruleSchema).max(10).optional(),
  mappings: z.array(mappingSchema).min(1).max(PRICING_LIMITS.plan_changes),
}).strict();
export const materialGroupSchema = z.object({
  key: z.string(), scope: z.literal('family'), supplier: z.string(),
  identifier: z.string(), identifier_attribute: z.string(),
  identity: z.record(z.string(), z.unknown()),
}).strict();
export const changeSchema = z.object({
  row_index: z.number().int(), product_id: text, sku: z.string(), family_id: text,
  attribute: label, old_value: z.number().finite(), new_value: z.number().finite(),
  currency: z.string(), unit: z.string(), rule_id: label, source_ref: z.string(),
  inheritance_level: z.string(), evidence_digest: z.string(),
  calculated_value: z.number().finite().optional(), review_note: z.string().optional(),
  calculation_trace: calculationTraceSchema.optional(),
  review_evidence: z.record(z.string(), z.unknown()),
  material_group: materialGroupSchema.optional(),
  descendant_impact: z.array(z.object({ product_id: text, sku: z.string(), old_value: z.number().finite(), new_value: z.number().finite(), overridden: z.boolean(), evidence_digest: z.string(), review_evidence: z.record(z.string(), z.unknown()) }).strict()).max(10),
}).strict();
export type PricingChange = z.infer<typeof changeSchema>;
export const applyInput = z.object({ plan_id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/), changes: z.array(changeSchema).min(1).max(PRICING_LIMITS.plan_changes) }).strict();
export const rulesInput = z.object({ expected_revision: z.number().int().nonnegative(), rules: z.array(ruleSchema).max(100),
  review: reviewMetadataSchema.optional() }).strict();
export const rulesDocument = z.object({
  revision_context: revisionContextSchema.optional(),
  version_history: versionHistoryPointer.optional(),
  revision: z.number().int().nonnegative(), updated_at: z.string(), rules: z.array(ruleSchema).max(100),
  record_provenance: recordProvenanceSchema.optional(),
  // History is atomically stored with the current rules; archive copies are extra.
  history: z.array(z.object({ revision: z.number().int().nonnegative(), updated_at: z.string(), rules: z.array(ruleSchema).max(100) }).strict()).max(1000).default([]),
}).strict();
