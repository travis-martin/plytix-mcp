import { z } from 'zod';
import { changeSchema, decimal, mappingSchema, PRICING_LIMITS } from './model.js';

export const reviewStatus = z.enum(['pending', 'selected', 'rejected', 'needs_revision', 'blocked', 'unchanged']);
export const reviewBinding = z.object({ review_id: z.string().uuid(), revision: z.number().int().nonnegative(), line_ids: z.array(z.string()).min(1).max(PRICING_LIMITS.plan_changes) }).strict();
export const reviewLine = z.object({
  line_id: z.string(), status: reviewStatus,
  provenance: z.object({ plan_id: z.string().uuid(), import_id: z.string().uuid(), rule_id: z.string(), row_index: z.number(), mapping: mappingSchema }),
  source: z.object({ source_name: z.string(), source_sha256: z.string(), source_ref: z.string(), source_column: z.string(), source_values: z.record(z.string(), z.string()) }),
  change: changeSchema.optional(), reason: z.string().optional(), instruction: z.string().max(2000).optional(),
  proposed_value: decimal.nullable().optional(),
  prepared_plan_id: z.string().uuid().optional(), plan_history: z.array(z.string().uuid()).default([]),
});
export const reviewDocument = z.object({
  kind: z.literal('pricing_review'), review_id: z.string().uuid(), revision: z.number().int().nonnegative(),
  title: z.string().max(200), created_at: z.string(), updated_at: z.string(),
  lines: z.array(reviewLine).min(1).max(1000),
  batches: z.array(z.object({ batch_id: z.string().uuid(), plan_ids: z.array(z.string().uuid()), line_ids: z.array(z.string()), state: z.enum(['executing', 'complete', 'stopped', 'deferred']), started_at: z.string(), finished_at: z.string().optional(), error: z.string().optional() })).default([]),
});
export type ReviewDocument = z.infer<typeof reviewDocument>;
export type ReviewLine = z.infer<typeof reviewLine>;
export const reviewCreateInput = z.object({ plan_ids: z.array(z.string().uuid()).min(1).max(50), title: z.string().trim().min(1).max(200).optional() }).strict();
export const reviewGetInput = z.object({ review_id: z.string().uuid() }).strict();
export const reviewUpdateInput = z.object({
  review_id: z.string().uuid(), expected_revision: z.number().int().nonnegative(),
  decisions: z.array(z.object({ line_id: z.string(), status: reviewStatus, note: z.string().max(2000).optional(), proposed_value: decimal.nullable().optional() }).strict()).min(1).max(1000),
}).strict();
export const reviewPlanInput = z.object({ review_id: z.string().uuid(), expected_revision: z.number().int().nonnegative(), line_ids: z.array(z.string()).min(1).max(PRICING_LIMITS.review_lines).optional() }).strict();
export const manifestChange = changeSchema.pick({ product_id: true, sku: true, family_id: true, attribute: true, old_value: true, new_value: true, calculated_value: true, review_note: true, currency: true, unit: true, source_ref: true, inheritance_level: true }).extend({
  line_id: z.string(),
  descendants: z.array(z.object({ product_id: z.string(), sku: z.string(), old_value: z.number(), new_value: z.number(), overridden: z.boolean() }).strict()).max(10),
}).strict();
export const reviewApplyInput = z.object({
  review_id: z.string().uuid(), expected_revision: z.number().int().nonnegative(),
  plans: z.array(z.object({ plan_id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(100),
  changes: z.array(manifestChange).min(1).max(100),
}).strict();
