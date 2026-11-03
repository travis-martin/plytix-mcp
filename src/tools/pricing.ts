import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { registerTool } from './register.js';
import { applyInput, importInput, planInput, rulesInput } from '../pricing/model.js';
import { PricingService } from '../pricing/service.js';

const json = (data: unknown) => {
  const object = data as { blocked?: unknown[]; state?: string };
  const partial = Boolean(object.blocked?.length || object.state === 'stopped');
  return { content: [{ type: 'text', text: JSON.stringify({ ...(data as object), ...(partial ? { partial: true } : {}) }, null, 2) }] };
};
export function registerPricingTools(server: McpServer, client: PlytixClient) {
  const pricing = new PricingService(client);
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
}
