import { z } from 'zod';
import { changeSchema } from './model.js';

export const transportSchema = z.enum(['auto', 'bulk', 'patch']);
export const outcomeSchema = z.object({
  product_id: z.string(), attribute: z.string(),
  status: z.enum(['queued', 'sending_or_unknown', 'submitted', 'verified', 'unchanged', 'conflict', 'failed', 'validation_pending']),
  message: z.string().optional(),
}).strict();
export const batchRecord = z.object({
  kind: z.literal('pricing_batch'), batch_id: z.string().uuid(), manifest_digest: z.string(),
  approval_arguments: z.record(z.string(), z.unknown()),
  review_id: z.string().uuid(), review_revision: z.number(), plan_ids: z.array(z.string()),
  execution_revision: z.number().int().nonnegative().default(0),
  transport: transportSchema, used_transport: z.enum(['bulk', 'patch']).optional(),
  state: z.enum(['executing', 'pending', 'complete', 'stopped']),
  created_at: z.string(), updated_at: z.string(), lease_id: z.string().optional(), lease_until: z.number().optional(),
  changes: z.array(changeSchema), outcomes: z.array(outcomeSchema),
  baseline_id: z.string().uuid().optional(),
  bulk: z.object({ job_id: z.string(), product_ids: z.array(z.string()), settled: z.boolean(), status: z.string().optional(), unresolved_errors: z.number().int().nonnegative().default(0), completion_evidence: z.literal('verified_readback').optional() }).optional(),
  retry_at: z.number().optional(), errors: z.array(z.string()).default([]),
  metrics: z.object({ preflight_searches: z.number(), validation_searches: z.number(), patch_attempts: z.number(), bulk_attempts: z.number(), polls: z.number(), rate_limit_errors: z.number() }),
}).strict();
export type BatchRecord = z.infer<typeof batchRecord>;
export type BatchOutcome = z.infer<typeof outcomeSchema>;
