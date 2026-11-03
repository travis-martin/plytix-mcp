import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PlytixClient } from '../client.js';
import { PlytixError } from '../types.js';
import { createPricingStore, type PricingStore } from './store.js';
import { digest, PricingService, storedPlan, type StoredPlan } from './service.js';
import { serializeWriteApprovalArguments, writeApprovalArgumentLimit } from '../tools/register.js';
import { reviewApplyInput, reviewCreateInput, reviewDocument, reviewLine, reviewPlanInput, reviewUpdateInput, type ReviewDocument, type ReviewLine } from './review-model.js';
import { PRICING_LIMITS, type PricingChange } from './model.js';
import { PricingBatch } from './batch.js';
import { batchRecord } from './batch-model.js';

const fail = (message: string): never => { throw new PlytixError(message); };
const now = () => new Date().toISOString();
const lockedStatuses = new Set(['executing', 'queued', 'submitted', 'validation_pending', 'sending_or_unknown', 'verified', 'unchanged']);
type Execution = { status: string; plan_id: string; message?: string };
type PlanCache = Map<string, StoredPlan>;

function manifestChange(line: ReviewLine, change: PricingChange): z.infer<typeof reviewApplyInput>['changes'][number] {
  const { product_id, sku, family_id, attribute, old_value, new_value, currency, unit, source_ref, inheritance_level, calculated_value, review_note, material_group } = change;
  return { line_id: line.line_id, product_id, sku, family_id, attribute, old_value, new_value, currency, unit, source_ref, inheritance_level,
    ...(calculated_value === undefined ? {} : { calculated_value }), ...(review_note === undefined ? {} : { review_note }),
    ...(material_group ? { material_group } : {}),
    descendants: change.descendant_impact.map(({ product_id, sku, old_value, new_value, overridden }) => ({ product_id, sku, old_value, new_value, overridden })),
  };
}

// Conservative request envelope, not an account-specific upstream rate limit
// or a time-completion promise. Leave half the hard 4096-request budget for
// pagination/retries; the execution deadline still defers untouched rows.
const executionRequestLimit = 2048;
const executionAuthenticationRequests = 2;
function executionRequests(change?: PricingChange): number {
  const descendants = change?.descendant_impact.length ?? 0;
  // Conservative per-owner allowance for two shared snapshot passes, family
  // metadata and one fallback PATCH. Actual family pagination is bounded too;
  // this estimate does not impose artificial account-specific pacing.
  return 1 + 2 * Math.ceil((1 + descendants) / PRICING_LIMITS.search_page_size) + 2;
}

/** Durable decisions are drafts. Only the separately allowlisted, trusted-approval
 * pricing_review_apply tool can execute an exact server-verified manifest. */
export class PricingReviewService {
  private pricing: PricingService;
  constructor(private client: PlytixClient, private root = process.env.PLYTIX_PRICING_DIR,
    private storeFactory: (fingerprint: string, root?: string) => PricingStore = createPricingStore) {
    this.pricing = new PricingService(client, root, storeFactory);
  }
  private async directory() {
    await this.client.verifyKnowledgeAccess();
    return this.storeFactory(this.client.knowledgeFingerprint(), this.root);
  }
  private async read(id: string, store: PricingStore) {
    z.string().uuid().parse(id);
    return reviewDocument.parse(await store.read(`${id}.json`));
  }
  private async execution(review: ReviewDocument, store: PricingStore, plans: PlanCache = new Map()) {
    for (const id of new Set(review.lines.flatMap(line => line.plan_history))) if (!plans.has(id)) plans.set(id, await this.pricing.planGet(id, store));
    const states = new Map<string, Execution>();
    // An unsuccessful later attempt must never hide an earlier possible write.
    // Uncertainty dominates; otherwise preserve the strongest observed outcome.
    const priority: Record<string, number> = { skipped: 0, unchanged: 1, verified: 2, executing: 3, sending_or_unknown: 4 };
    for (const line of review.lines) {
      for (const id of line.plan_history) {
        const plan = plans.get(id)!;
        if (plan.execution_batch_id) continue;
        if (plan.state === 'draft') continue;
        const attribute = plan.rule_snapshot.find(rule => rule.id === line.provenance.rule_id)?.target_attribute;
        const result = plan.results.find(result => result.product_id === line.provenance.mapping.product_id && result.attribute === attribute);
        const observed = result?.status ?? (plan.state === 'executing' ? 'executing' : plan.state === 'complete' ? 'sending_or_unknown' : 'skipped');
        const status = Object.prototype.hasOwnProperty.call(priority, observed) ? observed : 'sending_or_unknown';
        if (priority[states.get(line.line_id)?.status ?? 'skipped'] > priority[status]) continue;
        states.set(line.line_id, { status, plan_id: id, ...(status === 'sending_or_unknown' ? { message: 'Inspect live state and audit before any replacement plan. Never blindly retry.' } : {}) });
      }
    }
    for (const batch of review.batches.filter(b => b.engine === 'batch')) {
      const saved = batchRecord.parse(await store.read(`${batch.batch_id}.json`));
      for (const line of review.lines.filter(line => batch.line_ids.includes(line.line_id))) {
        const result = saved.outcomes.find(o => o.product_id === line.provenance.mapping.product_id && o.attribute === line.change?.attribute);
        if (!result) continue;
        const status = result.status === 'queued' && saved.state === 'stopped' ? 'skipped' : result.status;
        states.set(line.line_id, { status, plan_id: line.prepared_plan_id ?? line.provenance.plan_id, ...(result.message ? { message: result.message } : {}) });
      }
    }
    return states;
  }
  private assertEditable(review: ReviewDocument, revision: number) {
    if (review.revision !== revision) fail('Review changed; reload the current revision');
    if (review.batches.some(batch => ['executing', 'pending'].includes(batch.state))) fail('Review execution is in progress or uncertain; refresh its audit before editing');
  }
  private async present(review: ReviewDocument, store: PricingStore, plans: PlanCache = new Map()) {
    const execution = await this.execution(review, store, plans);
    const lines = review.lines.map(line => ({ ...line, ...(execution.has(line.line_id) ? { execution: execution.get(line.line_id) } : {}) }));
    const counts: Record<string, number> = { total: lines.length, pending: 0, selected: 0, rejected: 0, needs_revision: 0, blocked: 0, unchanged: 0, awaiting_approval: 0, verified: 0, sending_or_unknown: 0, skipped: 0, executing: 0 };
    for (const line of lines) {
      counts[line.status]++;
      if (line.execution) counts[line.execution.status] = (counts[line.execution.status] ?? 0) + (line.execution.status === line.status ? 0 : 1);
      if (line.status === 'selected' && !lockedStatuses.has(line.execution?.status ?? '')) counts.awaiting_approval++;
    }
    const guidance = new Map<string, NonNullable<StoredPlan['guidance_binding']>>();
    for (const line of review.lines) {
      const binding = plans.get(line.prepared_plan_id ?? line.plan_history.at(-1) ?? line.provenance.plan_id)?.guidance_binding;
      if (binding) guidance.set(digest(binding), binding);
    }
    const continuations = [];
    for (const batch of review.batches.filter(b => b.engine === 'batch' && b.state !== 'complete')) {
      const saved = batchRecord.parse(await store.read(`${batch.batch_id}.json`));
      if (saved.review_revision === review.revision && saved.outcomes.some(o => o.status === 'queued') && !saved.outcomes.some(o => o.status === 'sending_or_unknown')) {
        const args = reviewApplyInput.parse(saved.approval_arguments);
        if (digest(args) === saved.manifest_digest) continuations.push({ batch_id: saved.batch_id, queued: saved.outcomes.filter(o => o.status === 'queued').length,
          approval: { tool_name: 'pricing_review_apply', arguments: args } });
      }
    }
    return { ...review, lines, counts, continuations, guidance_snapshots: [...guidance.values()], approval_required: true, instructions: 'Row decisions are drafts. Modified amounts need recalculation and fresh selection. Only exact trusted approval can execute the selected manifest. Workflow guidance shown here belongs to the saved plan revision; fresh preparation checks current protected guidance.' };
  }
  async get(id: string) { const store = await this.directory(); return this.present(await this.read(id, store), store); }
  async create(input: z.infer<typeof reviewCreateInput>) {
    input = reviewCreateInput.parse(input);
    if (new Set(input.plan_ids).size !== input.plan_ids.length) fail('Plan IDs must be unique');
    const store = await this.directory(), lines: ReviewLine[] = [], targets = new Set<string>(), plans: PlanCache = new Map();
    for (const id of input.plan_ids) {
      const plan = await this.pricing.planGet(id, store); plans.set(id, plan);
      for (const rule of plan.rule_snapshot) for (const mapping of plan.input.mappings) {
        const target = `${mapping.product_id}/${rule.target_attribute}`;
        if (targets.has(target)) fail('Review contains duplicate product/attribute targets; resolve conflicting source mappings first');
        targets.add(target);
        const change = plan.changes.find(c => c.product_id === mapping.product_id && c.row_index === mapping.row_index && c.rule_id === rule.id);
        const blocked = plan.blocked.find(b => b.row_index === mapping.row_index && b.rule_id === rule.id && (!b.product_id || b.product_id === mapping.product_id));
        const row = plan.source_snapshot.rows[mapping.row_index];
        if (!row || (!change && !blocked)) fail('Plan line evidence is incomplete');
        lines.push(reviewLine.parse({
          line_id: digest({ import_id: plan.import_id, row_index: mapping.row_index, product_id: mapping.product_id, rule_id: rule.id }),
          status: blocked ? 'blocked' : change!.old_value === change!.new_value ? 'unchanged' : 'pending',
          provenance: { plan_id: id, import_id: plan.import_id, rule_id: rule.id, row_index: mapping.row_index, mapping },
          source: { source_name: plan.source_snapshot.source_name, source_sha256: plan.source_snapshot.source_sha256, source_ref: row.source_ref, source_column: rule.source_column, source_values: row.values },
          ...(change ? { change } : {}), ...(blocked ? { reason: blocked.reason } : {}),
          ...(mapping.proposed_value ? { proposed_value: mapping.proposed_value, instruction: mapping.review_note } : {}),
          plan_history: [id],
        }));
      }
    }
    const review = reviewDocument.parse({ kind: 'pricing_review', review_id: randomUUID(), revision: 0, title: input.title ?? 'Price-list review', created_at: now(), updated_at: now(), lines, batches: [] });
    await store.create(`${review.review_id}.json`, review);
    return this.present(review, store, plans);
  }
  async update(input: z.infer<typeof reviewUpdateInput>) {
    input = reviewUpdateInput.parse(input);
    if (new Set(input.decisions.map(d => d.line_id)).size !== input.decisions.length) fail('Each line may appear only once in a decision batch');
    const store = await this.directory(), before = await this.read(input.review_id, store);
    this.assertEditable(before, input.expected_revision);
    const plans: PlanCache = new Map();
    const execution = await this.execution(before, store, plans);
    for (const decision of input.decisions) {
      const line = before.lines.find(line => line.line_id === decision.line_id) ?? fail('Unknown review line');
      if (lockedStatuses.has(execution.get(line.line_id)?.status ?? '')) fail('An executed or uncertain line cannot be edited or retried');
      if (decision.status === 'selected' && (!line.change || line.reason || line.status === 'needs_revision' || line.change.old_value === line.change.new_value)) fail('Recalculate blocked, unchanged or revised lines before selecting them');
      if (decision.proposed_value != null && !(decision.note ?? line.instruction)?.trim()) fail('A proposed amount requires a review instruction');
      if (['blocked', 'unchanged'].includes(decision.status)) fail('Blocked and unchanged status are calculated, not user decisions');
    }
    const next = await store.update(`${input.review_id}.json`, value => reviewDocument.parse(value), current => {
      this.assertEditable(current, input.expected_revision);
      if (digest(current.batches) !== digest(before.batches)) fail('Review execution changed; reload before editing');
      for (const decision of input.decisions) {
        const line = current.lines.find(line => line.line_id === decision.line_id)!;
        const changedAmount = decision.proposed_value !== undefined && decision.proposed_value !== line.proposed_value;
        const changedNote = decision.note !== undefined && decision.note !== line.instruction;
        if (decision.proposed_value !== undefined) line.proposed_value = decision.proposed_value;
        if (decision.note !== undefined) line.instruction = decision.note;
        if (decision.comment !== undefined) line.comment = decision.comment;
        line.status = decision.status === 'rejected' ? 'rejected' : changedAmount || changedNote ? 'needs_revision' : decision.status;
      }
      // Every previous prepared snapshot becomes invalid, including copied IDs.
      for (const line of current.lines) delete line.prepared_plan_id;
      current.revision++; current.updated_at = now(); return current;
    });
    return this.present(next, store, plans);
  }
  async plan(input: z.infer<typeof reviewPlanInput>) {
    input = reviewPlanInput.parse(input);
    const store = await this.directory(), before = await this.read(input.review_id, store);
    this.assertEditable(before, input.expected_revision);
    const cache: PlanCache = new Map();
    const execution = await this.execution(before, store, cache);
    const ids = input.line_ids ?? before.lines.filter(l => l.status === 'selected' && !lockedStatuses.has(execution.get(l.line_id)?.status ?? '')).map(l => l.line_id);
    if (!ids.length || ids.length > PRICING_LIMITS.review_lines || new Set(ids).size !== ids.length) fail(`Choose one to ${PRICING_LIMITS.review_lines} unique lines to prepare`);
    const requested = ids.map(id => before.lines.find(line => line.line_id === id) ?? fail('Unknown review line'));
    for (const line of requested) {
      if (lockedStatuses.has(execution.get(line.line_id)?.status ?? '')) fail('An executed or uncertain line cannot be prepared again');
      if (line.status === 'rejected') fail('Reset a rejected line before preparing it');
    }
    const deferred = new Set<string>(), reasons = new Set<string>(), selected: ReviewLine[] = [];
    let estimatedRequests = executionAuthenticationRequests;
    for (const line of requested) {
      const cost = line.status === 'selected' ? executionRequests(line.change) : 0;
      const reason = selected.length >= PRICING_LIMITS.plan_changes ? 'change_limit' : estimatedRequests + cost > executionRequestLimit ? 'execution_request_budget' : undefined;
      if (reason) { deferred.add(line.line_id); reasons.add(reason); continue; }
      selected.push(line); estimatedRequests += cost;
    }
    const revision = before.revision + 1;
    type PreparedLine = { line: ReviewLine; source: StoredPlan; mapping: ReviewLine['provenance']['mapping']; change?: PricingChange; reason?: string; status: ReviewLine['status']; plan?: StoredPlan };
    const prepared: PreparedLine[] = [];
    const learning: Array<Awaited<ReturnType<PricingService['plan']>>['learning']> = [];
    const groups = new Map<string, ReviewLine[]>();
    const sources = [...new Set(selected.map(line => line.provenance.plan_id))].map(id => cache.get(id)!);
    const snapshot = await this.pricing.batchSnapshot(sources, store);
    for (const line of selected) {
      const key = `${line.provenance.import_id}/${line.provenance.rule_id}/${digest(cache.get(line.provenance.plan_id)?.input.batch_rules ?? [])}`;
      const group = groups.get(key) ?? []; group.push(line); groups.set(key, group);
    }
    for (const lines of groups.values()) {
      const mappings = lines.map(line => {
        const mapping = { ...line.provenance.mapping };
        if (line.proposed_value == null) delete mapping.proposed_value;
        else mapping.proposed_value = line.proposed_value;
        if (line.instruction?.trim()) mapping.review_note = line.instruction;
        else delete mapping.review_note;
        return mapping;
      });
      const original = cache.get(lines[0].provenance.plan_id)!;
      const batchRule = original.input.batch_rules?.find(r => r.id === lines[0].provenance.rule_id);
      const source = await this.pricing.plan({ import_id: lines[0].provenance.import_id,
        rule_ids: batchRule ? [] : [lines[0].provenance.rule_id], ...(batchRule ? { batch_rules: [batchRule] } : {}), mappings }, undefined, { store, persist: false, snapshot });
      learning.push(source.learning);
      for (const [index, line] of lines.entries()) {
        const match = (item: { row_index: number; product_id?: string; rule_id: string }) => item.row_index === line.provenance.row_index && item.product_id === line.provenance.mapping.product_id && item.rule_id === line.provenance.rule_id;
        const change = source.changes.find(match), blocked = source.blocked.find(match);
        const stable = line.change && change && digest(line.change) === digest(change);
        const status = blocked || !change ? 'blocked' : change.old_value === change.new_value ? 'unchanged' : line.status === 'selected' && stable ? 'selected' : 'pending';
        prepared.push({ line, source, mapping: mappings[index], change, status, ...(blocked || !change ? { reason: blocked?.reason ?? 'Pricing evidence unavailable' } : {}) });
      }
    }
    const holdConflicts = (conflicts: Map<string, string>) => {
      for (const item of prepared) if (item.change && conflicts.has(`${item.change.product_id}/${item.change.attribute}`)) {
        const reason = conflicts.get(`${item.change.product_id}/${item.change.attribute}`)!;
        item.source.blocked.push({ row_index: item.change.row_index, rule_id: item.change.rule_id, product_id: item.change.product_id, family_id: item.change.family_id, reason });
        item.source.changes = item.source.changes.filter(c => c !== item.change);
        item.reason = reason; item.status = 'blocked'; delete item.change;
      }
    };
    holdConflicts(this.pricing.groupConflicts(prepared.flatMap(p => p.change ? [p.change] : []), snapshot));
    // A pending comparison does not authorize the other owners in its group.
    // Detect this during preparation, rather than wasting a write approval.
    holdConflicts(this.pricing.groupConflicts(prepared.filter(p => p.status === 'selected' && p.change).map(p => p.change!), snapshot));
    // Fit the actual manifest before persisting any plans. UUIDs/digests have
    // fixed lengths, so placeholders give the exact serialized size. Unselected
    // or changed rows are partitioned away and cannot poison ready rows.
    const approvalLines: PreparedLine[] = [];
    estimatedRequests = executionAuthenticationRequests;
    const approvalGroups = new Map<string, PreparedLine[]>();
    for (const item of prepared.filter(item => item.status === 'selected')) {
      const key = item.change?.material_group?.key ?? item.line.line_id;
      const group = approvalGroups.get(key) ?? []; group.push(item); approvalGroups.set(key, group);
    }
    for (const group of approvalGroups.values()) {
      const trial = [...approvalLines, ...group], cost = group.reduce((sum, item) => sum + executionRequests(item.change), 0);
      const sourceIds = [...new Set(trial.map(entry => entry.source.plan_id))];
      const trialManifest = { review_id: before.review_id, expected_revision: revision, transport: input.transport ?? 'auto', plans: sourceIds.map(plan_id => ({ plan_id, digest: '0'.repeat(64) })), changes: trial.map(entry => manifestChange(entry.line, entry.change!)) };
      const reason = estimatedRequests + cost > executionRequestLimit ? 'execution_request_budget' : serializeWriteApprovalArguments('pricing_review_apply', trialManifest).length > writeApprovalArgumentLimit('pricing_review_apply') ? 'approval_size_limit' : undefined;
      if (reason) { for (const item of group) deferred.add(item.line.line_id); reasons.add(reason); }
      else { approvalLines.push(...group); estimatedRequests += cost; }
    }
    const included = prepared.filter(item => !deferred.has(item.line.line_id));
    const partitions = new Map<string, PreparedLine[]>();
    for (const item of included) {
      const key = `${item.source.plan_id}/${item.status === 'selected' ? 'ready' : 'review'}`;
      const group = partitions.get(key) ?? []; group.push(item); partitions.set(key, group);
    }
    const plans: StoredPlan[] = [];
    for (const group of partitions.values()) {
      const plan = await this.pricing.saveReviewSubset(group[0].source, group.map(item => item.mapping), { review_id: before.review_id, revision, line_ids: group.map(item => item.line.line_id) }, store);
      plans.push(plan); cache.set(plan.plan_id, plan);
      for (const item of group) item.plan = plan;
    }
    const next = await store.update(`${before.review_id}.json`, value => reviewDocument.parse(value), current => {
      this.assertEditable(current, input.expected_revision);
      if (digest(current.batches) !== digest(before.batches)) fail('Review execution changed; reload before preparing');
      for (const line of current.lines) delete line.prepared_plan_id;
      for (const { line: old, plan, change, status, reason } of included) {
        const line = current.lines.find(line => line.line_id === old.line_id)!;
        line.plan_history.push(plan!.plan_id);
        line.status = status;
        if (reason || !change) { line.reason = reason ?? 'Pricing evidence unavailable'; delete line.change; continue; }
        line.change = change; delete line.reason;
        line.prepared_plan_id = plan!.plan_id;
      }
      current.prepared_transport = input.transport ?? 'auto';
      current.revision = revision; current.updated_at = now(); return current;
    });
    const ready = [...new Set(included.filter(item => item.status === 'selected').map(item => item.plan!.plan_id))];
    const approval = ready.length ? await this.manifest(next, ready, store, cache) : undefined;
    const argumentCharacters = approval ? serializeWriteApprovalArguments('pricing_review_apply', approval).length : 0;
    if (argumentCharacters > writeApprovalArgumentLimit('pricing_review_apply')) fail('Approval size changed unexpectedly; reprepare the review');
    return { review: await this.present(next, store, cache), plans, learning, pending_review: included.some(item => item.status !== 'selected'),
      batching: { requested: ids.length, prepared: included.length, deferred_count: deferred.size, deferred_line_ids: ids.filter(id => deferred.has(id)), reasons: [...reasons], max_changes: PRICING_LIMITS.plan_changes, estimated_api_requests: ready.length ? estimatedRequests : 0, max_estimated_api_requests: executionRequestLimit },
      ...(approval ? { approval: { tool_name: 'pricing_review_apply', arguments: approval, argument_characters: argumentCharacters } } : {}) };
  }
  private async manifest(review: ReviewDocument, ids: string[], store: PricingStore, cache: PlanCache = new Map()) {
    if (!ids.length || new Set(ids).size !== ids.length) fail('Select unique prepared plans');
    const execution = await this.execution(review, store, cache);
    const changes: z.infer<typeof reviewApplyInput>['changes'] = [], plans: z.infer<typeof reviewApplyInput>['plans'] = [];
    for (const id of ids) {
      const plan = cache.get(id) ?? await this.pricing.planGet(id, store);
      const binding = plan.review_binding;
      if (plan.state !== 'draft' || plan.blocked.length || !binding || binding.review_id !== review.review_id || binding.revision !== review.revision || Date.parse(plan.expires_at) <= Date.now()) fail('Prepared plan is blocked, stale or consumed; reprepare the selected lines');
      plans.push({ plan_id: id, digest: plan.digest });
      for (const change of plan.changes) {
        const line = review.lines.find(l => binding!.line_ids.includes(l.line_id) && l.prepared_plan_id === id && l.status === 'selected' && l.change?.product_id === change.product_id && l.change.attribute === change.attribute) ?? fail('Prepared plan no longer matches the selected review lines');
        if (lockedStatuses.has(execution.get(line.line_id)?.status ?? '')) fail('An executed or uncertain line cannot be approved or retried');
        if (digest(line.change) !== digest(change)) fail('Prepared review values changed');
        changes.push(manifestChange(line, change));
      }
    }
    if (new Set(changes.map(c => c.line_id)).size !== changes.length) fail('Approval manifest repeats a target');
    return reviewApplyInput.parse({ review_id: review.review_id, expected_revision: review.revision, ...(review.prepared_transport ? { transport: review.prepared_transport } : {}), plans, changes });
  }
  private async finishBatch(id: string, store: PricingStore, write: boolean) {
    const executor = new PricingBatch(this.client, this.pricing, store);
    const saved = await executor.read(id);
    // Resume a partially persisted reservation only inside its already-reserved
    // review. This is idempotent; another execution can never consume these plans.
    if (write) {
      const review = await this.read(saved.review_id, store);
      if (review.revision !== saved.review_revision || !review.batches.some(b => b.batch_id === id && b.manifest_digest === saved.manifest_digest)) fail('Batch review reservation changed');
      for (const planId of saved.plan_ids) await store.update(`${planId}.json`, value => storedPlan.parse(value), current => {
        if (current.execution_batch_id === id) return current;
        if (current.state !== 'draft' || current.execution_batch_id) fail('Plan was consumed by another execution');
        current.execution_batch_id = id; current.state = 'executing'; return current;
      });
    }
    const plans = await Promise.all(saved.plan_ids.map(id => this.pricing.planGet(id, store)));
    if (plans.some(plan => plan.execution_batch_id !== id)) fail('Batch reservation is incomplete or belongs to another execution; inspect the audit');
    const result = await executor.run(id, plans, write);
    for (const plan of plans) await store.update(`${plan.plan_id}.json`, value => storedPlan.parse(value), current => {
      if ((current.execution_batch_revision ?? -1) > result.execution_revision) return current;
      current.execution_batch_id = id;
      current.execution_batch_revision = result.execution_revision;
      current.state = result.state === 'complete' ? 'complete' : result.state === 'stopped' ? 'stopped' : 'deferred';
      current.results = result.outcomes.filter(o => plan.changes.some(c => c.product_id === o.product_id && c.attribute === o.attribute));
      return current;
    });
    const next = await store.update(`${saved.review_id}.json`, value => reviewDocument.parse(value), current => {
      const batch = current.batches.find(b => b.batch_id === id) ?? fail('Execution review binding is unavailable');
      if ((batch.execution_revision ?? -1) > result.execution_revision) return current;
      batch.execution_revision = result.execution_revision;
      batch.state = result.state; batch.error = result.errors.length ? result.errors.join('; ') : undefined;
      if (result.state === 'complete' || result.state === 'stopped') batch.finished_at = now();
      current.updated_at = now(); return current;
    });
    return { review: await this.present(next, store), batch: result, state: result.state,
      ...(result.state !== 'complete' ? { partial: true, next: result.outcomes.some(o => o.status === 'queued')
        ? 'Refresh validation, then resume the same exact approval manifest through pricing_review_apply. Never resend submitted or uncertain rows.'
        : 'Use pricing_review_refresh to poll the saved job and validate results without sending any product updates.' } : {}) };
  }

  async refresh(id: string) {
    const store = await this.directory(), review = await this.read(id, store);
    const batches = review.batches.filter(b => b.engine === 'batch' && b.state !== 'complete');
    for (const batch of batches) await this.finishBatch(batch.batch_id, store, false);
    return this.present(await this.read(id, store), store);
  }

  async apply(input: z.infer<typeof reviewApplyInput>) {
    input = reviewApplyInput.parse(input);
    const store = await this.directory(), before = await this.read(input.review_id, store);
    if (before.revision !== input.expected_revision) fail('Review changed; reload the current revision');
    const fingerprint = digest(input);
    const previous = before.batches.find(b => b.engine === 'batch' && b.manifest_digest === fingerprint);
    if (previous) return this.finishBatch(previous.batch_id, store, true);
    this.assertEditable(before, input.expected_revision);
    const cache: PlanCache = new Map();
    const exact = await this.manifest(before, input.plans.map(p => p.plan_id), store, cache);
    if (digest(exact) !== fingerprint) fail('Approval manifest was altered; request exact approval again');
    const plans = await Promise.all(exact.plans.map(p => this.pricing.planGet(p.plan_id, store)));
    const batchId = randomUUID();
    const executor = new PricingBatch(this.client, this.pricing, store);
    await executor.create(input, plans, fingerprint, batchId);
    await store.update(`${before.review_id}.json`, value => reviewDocument.parse(value), current => {
      this.assertEditable(current, input.expected_revision);
      if (digest(current.batches) !== digest(before.batches)) fail('Review execution changed; reload before applying');
      current.batches.push({ batch_id: batchId, plan_ids: plans.map(p => p.plan_id), line_ids: exact.changes.map(c => c.line_id),
        state: 'executing', engine: 'batch', manifest_digest: fingerprint, started_at: now() });
      return current;
    });
    return this.finishBatch(batchId, store, true);
  }
}
