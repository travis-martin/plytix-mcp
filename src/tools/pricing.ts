import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { registerTool } from './register.js';
import { applyInput, importInput, planInput, rulesInput } from '../pricing/model.js';
import { PricingService } from '../pricing/service.js';
import { PricingReviewService } from '../pricing/review.js';
import { reviewApplyInput, reviewCreateInput, reviewGetInput, reviewPlanInput, reviewUpdateInput } from '../pricing/review-model.js';

const json = (data: unknown) => {
  const object = data as { blocked?: unknown[]; state?: string };
  const partial = Boolean(object.blocked?.length || object.state === 'stopped');
  return { content: [{ type: 'text', text: JSON.stringify({ ...(data as object), ...(partial ? { partial: true } : {}) }, null, 2) }] };
};
export function registerPricingTools(server: McpServer, client: PlytixClient) {
  const pricing = new PricingService(client);
  const reviews = new PricingReviewService(client);
  registerTool(server, 'pricing_import', {
    title: 'Import a Price List and Suggest Families',
    description: 'Read a CSV or document-reader extracted rows (maximum 20). Match exact SKUs and suggest product families FIRST; never infer a family assignment or update products. Saves a private source snapshot. Requires PLYTIX_PRICING_DIR.',
    inputSchema: importInput.shape,
  }, async (args: z.infer<typeof importInput>) => json(await pricing.importDocument(args)));
  registerTool(server, 'pricing_rules_get', {
    title: 'Review Pricing Rules', description: 'Read credential-scoped rules.json with versioned confirmed/proposed associations, conditions, calculations and restrictions.', inputSchema: {},
  }, async () => json(await pricing.rulesGet()));
  registerTool(server, 'pricing_rules_save', {
    title: 'Save Reviewed Pricing Rules', description: 'Replace the full pricing rule set at an expected revision. Requires exact host approval and pricing_rules_save allowlist. Proposed rules never calculate updates; marking confirmed requires reviewing the complete rule. Does not change Plytix products.', inputSchema: rulesInput.shape,
  }, async (args: z.infer<typeof rulesInput>) => json(await pricing.rulesSave(args)));
  registerTool(server, 'pricing_plan', {
    title: 'Preview Price Updates', description: 'After reviewing family suggestions, explicitly map document rows to products and families. Use confirmed rule IDs to calculate differences against live numeric values, inheritance and restrictions. Saves a 30-minute review plan; blocked rows prevent execution of the entire plan.', inputSchema: planInput.shape,
  }, async (args: z.infer<typeof planInput>) => json(await pricing.plan(args)));
  registerTool(server, 'pricing_plan_get', {
    title: 'Read Pricing Plan and Audit', description: 'Read a private saved plan, exact proposed updates, blocked reasons, and execution/readback audit. Never retries writes.', inputSchema: { plan_id: z.string().uuid() },
  }, async ({ plan_id }: { plan_id: string }) => json(await pricing.planGet(plan_id)));
  registerTool(server, 'pricing_apply', {
    title: 'Apply Reviewed Price Updates', description: 'Execute the exact reviewed plan and full changes after trusted host approval. Recheck values, rules and inheritance, reserve plan once, update and read back each value. Stops on uncertainty; no automatic retry or rollback. Only allowlisted pricing_apply can PATCH products.', inputSchema: applyInput.shape,
  }, async (args: z.infer<typeof applyInput>) => json(await pricing.apply(args)));
  registerTool(server, 'pricing_review_create', {
    title: 'Create a Price Review', description: 'Combine saved plans into a durable private review with per-line source evidence, inheritance impacts and decisions. No Plytix changes. Lines start pending, blocked or unchanged; selection never authorizes a write.', inputSchema: reviewCreateInput.shape,
  }, async (args: z.infer<typeof reviewCreateInput>) => json(await reviews.create(args)));
  registerTool(server, 'pricing_review_get', {
    title: 'Read Price Review Status', description: 'Read every line decision and latest execution/readback status, including pending, rejected, revised, blocked, selected, verified and uncertain lines. Never retries writes.', inputSchema: reviewGetInput.shape,
  }, async ({ review_id }: z.infer<typeof reviewGetInput>) => json(await reviews.get(review_id)));
  registerTool(server, 'pricing_review_update', {
    title: 'Revise Price Review Decisions', description: 'Save individual or batch draft selections, rejections, instructions and exact proposed amounts using the current review revision. Modified amounts require an instruction and fresh recalculation/selection. No Plytix changes; clears previous prepared approval snapshots.', inputSchema: reviewUpdateInput.shape,
  }, async (args: z.infer<typeof reviewUpdateInput>) => json(await reviews.update(args)));
  registerTool(server, 'pricing_review_plan', {
    title: 'Prepare Selected Review Lines', description: 'Recalculate selected lines (or explicit line IDs) against current catalog, rules, inheritance and overrides. Return fresh review and exact batch approval arguments. Changed evidence returns to pending. No Plytix changes.', inputSchema: reviewPlanInput.shape,
  }, async (args: z.infer<typeof reviewPlanInput>) => json(await reviews.plan(args)));
  registerTool(server, 'pricing_review_apply', {
    title: 'Apply Selected Reviewed Prices', description: 'After exact trusted host approval, verify the complete server-produced batch manifest and all selected plans before writing. Update only approved inheritance owners; preserve child overrides; persist each outcome and stop on uncertainty. Requires pricing_review_apply allowlist; PATCH products only. Never retry uncertain lines.', inputSchema: reviewApplyInput.shape,
  }, async (args: z.infer<typeof reviewApplyInput>) => json(await reviews.apply(args)));
}
