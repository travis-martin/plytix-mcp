import { z } from 'zod';
import { importInput, label, PRICING_LIMITS, ruleSchema, sourceRow } from './model.js';

/** An audit accepts source evidence directly and cannot be submitted as a plan. */
export const auditInput = z.object({
  source_name: importInput.shape.source_name,
  source_sha256: importInput.shape.source_sha256,
  sku_column: importInput.shape.sku_column,
  source_context: importInput.shape.source_context,
  rows: z.array(sourceRow).min(1).max(PRICING_LIMITS.import_rows),
  rules: z.array(ruleSchema).min(1).max(10),
  mappings: z.array(z.object({
    row_index: z.number().int().min(0).max(PRICING_LIMITS.import_rows - 1),
    product_id: z.string().trim().min(1).max(200),
    family_id: z.string().trim().min(1).max(200), rule_id: label,
  }).strict()).min(1).max(PRICING_LIMITS.plan_changes),
}).strict();
export type AuditInput = z.infer<typeof auditInput>;
