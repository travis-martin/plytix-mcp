import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PlytixClient } from '../client.js';
import { PlytixError } from '../types.js';
import { createPricingStore, type PricingStore } from './store.js';
import { digest, PricingService, type StoredPlan } from './service.js';
import { serializeWriteApprovalArguments, writeApprovalArgumentLimit } from '../tools/register.js';
import { reviewApplyInput, reviewCreateInput, reviewDocument, reviewLine, reviewPlanInput, reviewUpdateInput, type ReviewDocument, type ReviewLine } from './review-model.js';

const fail = (message: string): never => { throw new PlytixError(message); };
const now = () => new Date().toISOString();
const lockedStatuses = new Set(['executing', 'sending_or_unknown', 'verified', 'unchanged']);
type Execution = { status: string; plan_id: string; message?: string };

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
  private async execution(review: ReviewDocument) {
    const plans = new Map<string, StoredPlan>();
    for (const id of new Set(review.lines.flatMap(line => line.plan_history))) plans.set(id, await this.pricing.planGet(id));
    const states = new Map<string, Execution>();
    // An unsuccessful later attempt must never hide an earlier possible write.
    // Uncertainty dominates; otherwise preserve the strongest observed outcome.
    const priority: Record<string, number> = { skipped: 0, unchanged: 1, verified: 2, executing: 3, sending_or_unknown: 4 };
    for (const line of review.lines) {
      for (const id of line.plan_history) {
        const plan = plans.get(id)!;
        if (plan.state === 'draft') continue;
        const attribute = plan.rule_snapshot.find(rule => rule.id === line.provenance.rule_id)?.target_attribute;
        const result = plan.results.find(result => result.product_id === line.provenance.mapping.product_id && result.attribute === attribute);
        const observed = result?.status ?? (plan.state === 'executing' ? 'executing' : plan.state === 'complete' ? 'sending_or_unknown' : 'skipped');
        const status = Object.prototype.hasOwnProperty.call(priority, observed) ? observed : 'sending_or_unknown';
        if (priority[states.get(line.line_id)?.status ?? 'skipped'] > priority[status]) continue;
        states.set(line.line_id, { status, plan_id: id, ...(status === 'sending_or_unknown' ? { message: 'Inspect live state and audit before any replacement plan. Never blindly retry.' } : {}) });
      }
    }
    return states;
  }
  private assertEditable(review: ReviewDocument, revision: number) {
    if (review.revision !== revision) fail('Review changed; reload the current revision');
    if (review.batches.some(batch => batch.state === 'executing')) fail('Review execution is in progress or uncertain; inspect its audit before editing');
  }
  private async present(review: ReviewDocument) {
    const execution = await this.execution(review);
    const lines = review.lines.map(line => ({ ...line, ...(execution.has(line.line_id) ? { execution: execution.get(line.line_id) } : {}) }));
    const counts: Record<string, number> = { total: lines.length, pending: 0, selected: 0, rejected: 0, needs_revision: 0, blocked: 0, unchanged: 0, awaiting_approval: 0, verified: 0, sending_or_unknown: 0, skipped: 0, executing: 0 };
    for (const line of lines) {
      counts[line.status]++;
      if (line.execution) counts[line.execution.status] = (counts[line.execution.status] ?? 0) + (line.execution.status === line.status ? 0 : 1);
      if (line.status === 'selected' && !lockedStatuses.has(line.execution?.status ?? '')) counts.awaiting_approval++;
    }
    return { ...review, lines, counts, approval_required: true, instructions: 'Row decisions are drafts. Modified amounts need recalculation and fresh selection. Only exact trusted approval can execute the selected manifest.' };
  }
  async get(id: string) { return this.present(await this.read(id, await this.directory())); }
  async create(input: z.infer<typeof reviewCreateInput>) {
    input = reviewCreateInput.parse(input);
    if (new Set(input.plan_ids).size !== input.plan_ids.length) fail('Plan IDs must be unique');
    const store = await this.directory(), lines: ReviewLine[] = [], targets = new Set<string>();
    for (const id of input.plan_ids) {
      const plan = await this.pricing.planGet(id);
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
    return this.present(review);
  }
  async update(input: z.infer<typeof reviewUpdateInput>) {
    input = reviewUpdateInput.parse(input);
    if (new Set(input.decisions.map(d => d.line_id)).size !== input.decisions.length) fail('Each line may appear only once in a decision batch');
    const store = await this.directory(), before = await this.read(input.review_id, store);
    this.assertEditable(before, input.expected_revision);
    const execution = await this.execution(before);
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
        line.status = decision.status === 'rejected' ? 'rejected' : changedAmount || changedNote ? 'needs_revision' : decision.status;
      }
      // Every previous prepared snapshot becomes invalid, including copied IDs.
      for (const line of current.lines) delete line.prepared_plan_id;
      current.revision++; current.updated_at = now(); return current;
    });
    return this.present(next);
  }
  async plan(input: z.infer<typeof reviewPlanInput>) {
    input = reviewPlanInput.parse(input);
    const store = await this.directory(), before = await this.read(input.review_id, store);
    this.assertEditable(before, input.expected_revision);
    const execution = await this.execution(before);
    const ids = input.line_ids ?? before.lines.filter(l => l.status === 'selected' && !lockedStatuses.has(execution.get(l.line_id)?.status ?? '')).map(l => l.line_id);
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length) fail('Choose one to 100 unique lines to prepare');
    const selected = ids.map(id => before.lines.find(line => line.line_id === id) ?? fail('Unknown review line'));
    for (const line of selected) {
      if (lockedStatuses.has(execution.get(line.line_id)?.status ?? '')) fail('An executed or uncertain line cannot be prepared again');
      if (line.status === 'rejected') fail('Reset a rejected line before preparing it');
    }
    const revision = before.revision + 1;
    const prepared: Array<{ line: ReviewLine; plan: StoredPlan }> = [];
    for (const line of selected) {
      const mapping = { ...line.provenance.mapping };
      if (line.proposed_value == null) delete mapping.proposed_value;
      else mapping.proposed_value = line.proposed_value;
      if (line.instruction?.trim()) mapping.review_note = line.instruction;
      else delete mapping.review_note;
      const plan = await this.pricing.plan({ import_id: line.provenance.import_id, rule_ids: [line.provenance.rule_id], mappings: [mapping] }, { review_id: before.review_id, revision, line_ids: [line.line_id] });
      prepared.push({ line, plan });
    }
    const next = await store.update(`${before.review_id}.json`, value => reviewDocument.parse(value), current => {
      this.assertEditable(current, input.expected_revision);
      if (digest(current.batches) !== digest(before.batches)) fail('Review execution changed; reload before preparing');
      for (const line of current.lines) delete line.prepared_plan_id;
      for (const { line: old, plan } of prepared) {
        const line = current.lines.find(line => line.line_id === old.line_id)!;
        const change = plan.changes[0];
        line.plan_history.push(plan.plan_id);
        if (plan.blocked.length || !change) { line.status = 'blocked'; line.reason = plan.blocked[0]?.reason ?? 'Pricing evidence unavailable'; delete line.change; continue; }
        const stable = old.change && digest(old.change) === digest(change);
        line.change = change; delete line.reason;
        line.status = change.old_value === change.new_value ? 'unchanged' : old.status === 'selected' && stable ? 'selected' : 'pending';
        line.prepared_plan_id = plan.plan_id;
      }
      current.revision = revision; current.updated_at = now(); return current;
    });
    const ready = prepared.filter(p => next.lines.some(line => line.line_id === p.line.line_id && line.status === 'selected'));
    const approval = ready.length ? await this.manifest(next, ready.map(p => p.plan.plan_id)) : undefined;
    const argumentCharacters = approval ? serializeWriteApprovalArguments('pricing_review_apply', approval).length : 0;
    const oversized = argumentCharacters > writeApprovalArgumentLimit('pricing_review_apply');
    return { review: await this.present(next), plans: prepared.map(p => p.plan), pending_review: prepared.some(p => next.lines.find(l => l.line_id === p.line.line_id)?.status !== 'selected'),
      ...(oversized ? { approval_blocked: 'The complete approval manifest is too large; prepare a smaller checked selection. Saved decisions are unchanged.' } : approval ? { approval: { tool_name: 'pricing_review_apply', arguments: approval, argument_characters: argumentCharacters } } : {}) };
  }
  private async manifest(review: ReviewDocument, ids: string[]) {
    if (!ids.length || new Set(ids).size !== ids.length) fail('Select unique prepared plans');
    const execution = await this.execution(review);
    const changes: z.infer<typeof reviewApplyInput>['changes'] = [], plans: z.infer<typeof reviewApplyInput>['plans'] = [];
    for (const id of ids) {
      const plan = await this.pricing.planGet(id);
      const binding = plan.review_binding;
      if (plan.state !== 'draft' || plan.blocked.length || !binding || binding.review_id !== review.review_id || binding.revision !== review.revision || Date.parse(plan.expires_at) <= Date.now()) fail('Prepared plan is blocked, stale or consumed; reprepare the selected lines');
      plans.push({ plan_id: id, digest: plan.digest });
      for (const change of plan.changes) {
        const line = review.lines.find(l => binding!.line_ids.includes(l.line_id) && l.prepared_plan_id === id && l.status === 'selected' && l.change?.product_id === change.product_id && l.change.attribute === change.attribute) ?? fail('Prepared plan no longer matches the selected review lines');
        if (lockedStatuses.has(execution.get(line.line_id)?.status ?? '')) fail('An executed or uncertain line cannot be approved or retried');
        if (digest(line.change) !== digest(change)) fail('Prepared review values changed');
        const { product_id, sku, family_id, attribute, old_value, new_value, currency, unit, source_ref, inheritance_level, calculated_value, review_note } = change;
        changes.push({ line_id: line.line_id, product_id, sku, family_id, attribute, old_value, new_value, currency, unit, source_ref, inheritance_level,
          ...(calculated_value === undefined ? {} : { calculated_value }), ...(review_note === undefined ? {} : { review_note }),
          descendants: change.descendant_impact.map(({ product_id, sku, old_value, new_value, overridden }) => ({ product_id, sku, old_value, new_value, overridden })),
        });
      }
    }
    if (new Set(changes.map(c => c.line_id)).size !== changes.length) fail('Approval manifest repeats a target');
    return reviewApplyInput.parse({ review_id: review.review_id, expected_revision: review.revision, plans, changes });
  }
  async apply(input: z.infer<typeof reviewApplyInput>) {
    input = reviewApplyInput.parse(input);
    const store = await this.directory(), before = await this.read(input.review_id, store);
    this.assertEditable(before, input.expected_revision);
    const exact = await this.manifest(before, input.plans.map(p => p.plan_id));
    if (digest(exact) !== digest(input)) fail('Approval manifest was altered; request exact approval again');
    // Check every selected plan before sending any product mutation.
    for (const { plan_id } of exact.plans) await this.pricing.preflight(plan_id);
    const batch = { batch_id: randomUUID(), plan_ids: exact.plans.map(p => p.plan_id), line_ids: exact.changes.map(c => c.line_id), state: 'executing' as const, started_at: now() };
    await store.update(`${before.review_id}.json`, value => reviewDocument.parse(value), current => {
      this.assertEditable(current, input.expected_revision);
      current.batches.push(batch); return current;
    });
    const results: StoredPlan[] = []; let error: string | undefined;
    try {
      for (const item of exact.plans) {
        const plan = await this.pricing.planGet(item.plan_id);
        const result = await this.pricing.apply({ plan_id: item.plan_id, digest: item.digest, changes: plan.changes });
        results.push(result);
        if (result.state !== 'complete') { error = 'Execution stopped; inspect per-line outcomes before any further action'; break; }
      }
    } catch (cause) { error = cause instanceof PlytixError ? cause.message : 'Execution is uncertain; inspect saved plans before taking further action'; }
    const next = await store.update(`${before.review_id}.json`, value => reviewDocument.parse(value), current => {
      const record = current.batches.find(b => b.batch_id === batch.batch_id)!;
      record.state = error ? 'stopped' : 'complete'; record.finished_at = now(); if (error) record.error = error;
      current.updated_at = now(); return current;
    });
    return { review: await this.present(next), plans: results, state: error ? 'stopped' : 'complete', ...(error ? { partial: true, error } : {}) };
  }
}
