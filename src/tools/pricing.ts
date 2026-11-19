import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { registerTool } from './register.js';
import { REVIEW_UI_META } from './workspace.js';
import { applyInput, importInput, learningMode, planInput, rulesInput, PRICING_LIMITS, type LearningMode } from '../pricing/model.js';
import { memoryGetInput, memoryUpdateInput } from '../pricing/memory.js';
import { PricingDictionaryService } from '../pricing/dictionary.js';
import { PricingGuidanceService } from '../pricing/guidance-service.js';
import { guidanceGetInput, guidanceSaveInput } from '../pricing/guidance.js';
import { reviewMetadataSchema } from '../pricing/provenance.js';
import { PricingHistoryService } from '../pricing/history-service.js';
import { historyGetInput } from '../pricing/version-history.js';
import { PricingService } from '../pricing/service.js';
import { PricingAuditService } from '../pricing/audit.js';
import { auditInput } from '../pricing/audit-model.js';
import { PricingReviewService } from '../pricing/review.js';
import { reviewApplyInput, reviewCreateInput, reviewGetInput, reviewPlanInput, reviewUpdateInput } from '../pricing/review-model.js';

const json = (data: unknown) => {
  const object = data as { blocked?: unknown[]; state?: string };
  const partial = Boolean(object.blocked?.length || object.state === 'stopped');
  return { content: [{ type: 'text', text: JSON.stringify({ ...(data as object), ...(partial ? { partial: true } : {}) }, null, 2) }] };
};
export function registerPricingTools(server: McpServer, client: PlytixClient) {
  const pricing = new PricingService(client);
  const audit = new PricingAuditService(client);
  const reviews = new PricingReviewService(client);
  const dictionary = new PricingDictionaryService(client);
  const guidance = new PricingGuidanceService(client);
  const history = new PricingHistoryService(client);
  registerTool(server, 'pricing_history_get', {
    title: 'Read Retained Knowledge Revisions',
    description: 'Read immutable workflow, dictionary or rule revisions reachable from the current committed head. Includes content hashes, before/after digest links, sources and review metadata. Unreferenced CAS candidates are not history. Use include_snapshots=true with limit=1 to capture one full revision for offline rollback preparation. Never writes, restores, learns or changes products.',
    inputSchema: historyGetInput.shape,
  }, async (args: z.infer<typeof historyGetInput>) => ({ ...json(await history.get(args)), resultMetadata: { source: 'local', freshness: 'cached' } }));
  registerTool(server, 'pricing_guidance_get', {
    title: 'Read Required Pricing Workflow Guidance',
    description: 'Read BEFORE every pricing task. Returns protected user instructions and enforced pricing exclusions, current revision/digest and storage scope. Global instructions apply alongside family/source-specific guidance. Explicit business constraints take precedence over learned suggestions; live Plytix remains authoritative for catalog facts. For editing, load unfiltered with include_retired=true so no existing instruction is omitted.',
    inputSchema: guidanceGetInput.shape,
  }, async (args: z.infer<typeof guidanceGetInput>) => ({ ...json(await guidance.get(args)), resultMetadata: { source: 'local', freshness: 'cached' } }));
  registerTool(server, 'pricing_guidance_save', {
    title: 'Save Protected Pricing Workflow Guidance',
    description: 'Save the complete user-reviewed instruction/exclusion set at expected_revision. Preserve every existing ID; retire explicitly instead of omitting. Supply review sources and reason for changes; altering an active exclusion requires them. Conflicting source evidence does not override a protection: resolve with the user first. Server records per-record before/after history; supplied reviewer attribution is not approval. Requires the write allowlist and normal host approval. Changes invalidate plans; never changes products or executes text.',
    inputSchema: { ...guidanceSaveInput.shape, review: reviewMetadataSchema },
  }, async (args: z.infer<typeof guidanceSaveInput>) => ({ ...json(await guidance.save(args)), resultMetadata: { source: 'local', freshness: 'not_applicable' } }));
  registerTool(server, 'pricing_audit', {
    title: 'Audit Supplier Costs Without Changes',
    description: 'Compare explicitly mapped cost owners to source rows and calculation rules using current family inheritance, ancestry, numeric schema, source associations, units and dimensions. Always proposal-only: never stores imports, plans, dictionary learning or products. Supports source rates with up to 18 fractional digits and rounds only the final amount. Returns matched, difference, protected or blocked evidence, never an executable plan. Descendants and their overrides are not inspected; any later update needs a fresh pricing_plan and exact approval.',
    inputSchema: auditInput.shape,
  }, async (args: z.infer<typeof auditInput>) => json(await audit.compare(args)));
  registerTool(server, 'pricing_dictionary_get', {
    title: 'Read Pricing Workflow Dictionary',
    description: 'Read paged supplier/source/family-scoped terminology, mappings and setup observations with source and per-record change/review history. Missing legacy history is unknown. All entries are advisory and require current Plytix validation; stale_source=false does not certify freshness. Use scope to prevent reusing unrelated meanings.',
    inputSchema: memoryGetInput.shape,
  }, async (args: z.infer<typeof memoryGetInput>) => ({ ...json(await dictionary.get(args)), resultMetadata: { source: 'local', freshness: 'cached' } }));
  registerTool(server, 'pricing_dictionary_update', {
    title: 'Save Pricing Workflow Definitions',
    description: 'Save reviewed advisory definitions at the current dictionary revision after the separate knowledge proposal is approved. Requires review sources and reason. Extracted terms, colors, materials and setup notes use proposed status and source evidence (plus source_sha256 when available). Use user_defined only for explicit user corrections; retire outdated meanings. Does not confirm pricing rules or change Plytix. Never copy prices, product records or full option lists. Current Plytix remains authoritative.',
    inputSchema: { ...memoryUpdateInput.shape, review: reviewMetadataSchema },
  }, async (args: z.infer<typeof memoryUpdateInput>) => ({ ...json(await dictionary.update(args)), resultMetadata: { source: 'local', freshness: 'not_applicable' } }));
  registerTool(server, 'pricing_import', {
    title: 'Import a Price List and Suggest Families',
    description: `Read a CSV or document-reader extracted rows (maximum ${PRICING_LIMITS.import_rows}). Match exact SKUs in paginated batches and suggest product families FIRST; never infer a family assignment or update products. Supply supplier/source_namespace in source_context for reusable, scoped advisory learning. Set learning_mode=proposal_only to return and retain candidate definitions privately without updating the dictionary; automatic remains the default. Saves a private source snapshot. Requires configured pricing storage.`,
    inputSchema: importInput.shape,
  }, async (args: z.infer<typeof importInput>) => json(await pricing.importDocument(args)));
  registerTool(server, 'pricing_rules_get', {
    title: 'Review Pricing Rules', description: 'Read versioned confirmed/proposed calculation rules, conditions and restrictions with storage-scope metadata. Set learning_mode=proposal_only to return advisory index candidates without saving them. Also read pricing_guidance_get for protected workflow instructions and exclusions.', inputSchema: { learning_mode: learningMode.optional() },
  }, async ({ learning_mode }: { learning_mode?: LearningMode }) => json(await pricing.rulesGet(learning_mode)));
  registerTool(server, 'pricing_rules_save', {
    title: 'Save Reviewed Pricing Rules', description: 'Replace the full pricing rule set at expected_revision with required review sources/reason. New or changed reusable supplier-cost rules require full_item_cost using current catalog dimensions and explicit source price units; do not encode a previous stock length or area as a fixed multiplier. Arithmetic adjustments must declare pricing_adjustment and have reviewed evidence. Old unchanged rules/history remain readable. Requires exact host approval and write allowlist; proposed rules never execute. Does not change Plytix products.', inputSchema: { ...rulesInput.shape, review: reviewMetadataSchema },
  }, async (args: z.infer<typeof rulesInput>) => json(await pricing.rulesSave(args)));
  registerTool(server, 'pricing_plan', {
    title: 'Preview Price Updates', description: 'After reviewing family suggestions, explicitly map document rows to products and families. Use confirmed rule_ids or private one-run batch_rules to calculate differences against live numeric values, inheritance and restrictions. batch_rules do not save or activate shared rules and still require exact approval of final changes. learning_mode inherits the import unless explicitly supplied; proposal_only retains advisory candidates in the private plan without dictionary writes. Saves a 30-minute review plan; blocked rows prevent execution of the entire plan.', inputSchema: planInput.shape,
  }, async (args: z.infer<typeof planInput>) => json(await pricing.plan(args)));
  registerTool(server, 'pricing_plan_get', {
    title: 'Read Pricing Plan and Audit', description: 'Read a private saved plan, exact proposed updates, blocked reasons, and execution/readback audit. Never retries writes.', inputSchema: { plan_id: z.string().uuid() },
  }, async ({ plan_id }: { plan_id: string }) => json(await pricing.planGet(plan_id)));
  registerTool(server, 'pricing_apply', {
    title: 'Apply Reviewed Price Updates', description: 'Execute the exact reviewed plan and full changes after trusted host approval. Recheck values, rules and inheritance, reserve plan once, update and read back each value. Stops on uncertainty; no automatic retry or rollback. Only allowlisted pricing_apply can PATCH products.', inputSchema: applyInput.shape,
  }, async (args: z.infer<typeof applyInput>) => json(await pricing.apply(args)));
  registerTool(server, 'pricing_review_create', {
    _meta: REVIEW_UI_META,
    title: 'Create a Price Review', description: 'Combine saved plans and optional non-executable coverage entries into a durable private review with source evidence, inheritance impacts and decisions. Coverage can record missing source prices, protected items, unused alternatives or unresolved mappings; coverage-only drafts use plan_ids=[]. Coverage never creates a price or becomes an executable line. No Plytix changes. Lines start pending, blocked or unchanged; selection never authorizes a write.', inputSchema: reviewCreateInput.shape,
  }, async (args: z.infer<typeof reviewCreateInput>) => json(await reviews.create(args)));
  registerTool(server, 'pricing_review_get', {
    _meta: REVIEW_UI_META,
    title: 'Read Price Review Status', description: 'Read every line decision and latest execution/readback status, including pending, rejected, revised, blocked, selected, verified and uncertain lines. Never retries writes.', inputSchema: reviewGetInput.shape,
  }, async ({ review_id }: z.infer<typeof reviewGetInput>) => json(await reviews.get(review_id)));
  registerTool(server, 'pricing_review_refresh', {
    _meta: REVIEW_UI_META,
    title: 'Validate Submitted Price Updates', description: 'Poll existing bulk jobs and validate owners, children, overrides and preserved fields using paginated reads. Updates the private audit only. Never submits, retries or resumes product writes; queued changes require the exact approved pricing_review_apply manifest.', inputSchema: reviewGetInput.shape,
  }, async ({ review_id }: z.infer<typeof reviewGetInput>) => json(await reviews.refresh(review_id)));
  registerTool(server, 'pricing_review_update', {
    title: 'Revise Price Review Decisions', description: 'Save individual or batch draft selections, rejections, instructions and exact proposed amounts using the current review revision. Modified amounts require an instruction and fresh recalculation/selection. No Plytix changes; clears previous prepared approval snapshots.', inputSchema: reviewUpdateInput.shape,
  }, async (args: z.infer<typeof reviewUpdateInput>) => json(await reviews.update(args)));
  registerTool(server, 'pricing_review_plan', {
    _meta: REVIEW_UI_META,
    title: 'Prepare Selected Review Lines', description: 'Recalculate selected lines (or explicit line IDs) against current catalog, rules, inheritance and overrides. Group compatible plans and automatically size the next batch to execution and approval limits. Return batching/deferred counts, fresh review and exact approval arguments. Changed evidence returns to pending. No Plytix changes.', inputSchema: reviewPlanInput.shape,
  }, async (args: z.infer<typeof reviewPlanInput>) => json(await reviews.plan(args)));
  registerTool(server, 'pricing_review_apply', {
    title: 'Apply Selected Reviewed Prices', description: 'After exact trusted host approval, verify the complete server-produced manifest against one fresh family snapshot. Submit approved inheritance owners in one bulk update or fast per-owner PATCH fallback, then validate owners, children, overrides and preserved fields together. Transport auto/bulk/patch is part of approval. Resume only unsent rows of the same manifest; never replay submitted or uncertain writes. Only actual HTTP 429 triggers backoff. Requires pricing_review_apply allowlist.', inputSchema: reviewApplyInput.shape,
  }, async (args: z.infer<typeof reviewApplyInput>) => json(await reviews.apply(args)));
}
