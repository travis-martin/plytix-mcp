import { randomUUID } from 'node:crypto';
import type { PlytixClient } from '../client.js';
import { PlytixError, type PlytixProduct } from '../types.js';
import { batchRecord, type BatchRecord, type BatchOutcome } from './batch-model.js';
import type { PricingStore } from './store.js';
import { digest, PricingService, type StoredPlan } from './service.js';
import { valueOf, type PricingSnapshot } from './snapshot.js';

const key = (v: { product_id: string; attribute: string }) => `${v.product_id}/${v.attribute}`;
const now = () => new Date().toISOString();
const message = (e: unknown) => e instanceof PlytixError ? e.message : 'Execution interrupted; inspect saved outcomes before any retry';
const configuration = (snapshot: PricingSnapshot) => ({
  families: Object.fromEntries([...snapshot.families].map(([id, family]) => [id, digest(family.data.map(a => ({ id: a.id, label: a.label, attribute_level: a.attribute_level })).sort((a,b) => String(a.id).localeCompare(String(b.id))))])),
  schemas: Object.fromEntries([...snapshot.schemas].map(([id, schema]) => [id, digest(schema)])),
});
type Baseline = { products: PlytixProduct[]; fields: string[]; configuration: ReturnType<typeof configuration> };

/** A single durable executor shared by HTTP and stdio. Refresh only reads Plytix;
 * queued writes resume exclusively through the allowlisted, approved apply tool. */
export class PricingBatch {
  constructor(private client: PlytixClient, private pricing: PricingService, private store: PricingStore) {}

  async read(id: string) { return batchRecord.parse(await this.store.read(`${id}.json`)); }

  async create(args: { review_id: string; expected_revision: number; transport?: 'auto' | 'bulk' | 'patch' }, plans: StoredPlan[], manifestDigest: string, batchId: string) {
    const changes = plans.flatMap(p => p.changes);
    if (new Set(changes.map(key)).size !== changes.length) throw new PlytixError('Batch repeats a product attribute');
    const record = batchRecord.parse({ kind: 'pricing_batch', batch_id: batchId, manifest_digest: manifestDigest, approval_arguments: args,
      review_id: args.review_id, review_revision: args.expected_revision, plan_ids: plans.map(p => p.plan_id),
      transport: args.transport ?? 'auto', state: 'pending', created_at: now(), updated_at: now(), changes,
      outcomes: changes.map(c => ({ product_id: c.product_id, attribute: c.attribute, status: c.old_value === c.new_value ? 'unchanged' : 'queued' })),
      metrics: { preflight_searches: 0, validation_searches: 0, patch_attempts: 0, bulk_attempts: 0, polls: 0, rate_limit_errors: 0 }, errors: [] });
    await this.store.create(`${batchId}.json`, record); return record;
  }

  async run(id: string, plans: StoredPlan[], write: boolean) {
    const lease = randomUUID();
    const record = await this.store.update(`${id}.json`, value => batchRecord.parse(value), current => {
      if (current.lease_id && (current.lease_until ?? 0) > Date.now()) throw new PlytixError('Batch execution is in progress; refresh its status after the active operation');
      current.lease_id = lease; current.lease_until = Date.now() + 90_000; current.execution_revision++; return current;
    });
    const persist = async () => {
      record.updated_at = now();
      await this.store.update(`${id}.json`, value => batchRecord.parse(value), current => {
        if (current.lease_id !== lease) throw new PlytixError('Batch execution lease changed');
        return record;
      });
    };
    const outcome = (product: string, attribute: string) => record.outcomes.find(o => o.product_id === product && o.attribute === attribute)!;
    let phase: 'preflight' | 'execution' | 'validation' = 'preflight';
    let finishedWithoutCounters = false;
    try {
      if (digest(record.approval_arguments) !== record.manifest_digest || digest(record.changes) !== digest(plans.flatMap(p => p.changes))) throw new PlytixError('Saved batch approval or plan evidence changed');
      const approvedPlans = record.approval_arguments.plans as Array<{ plan_id: string; digest: string }>;
      for (const plan of plans) {
        const { input, changes, blocked, rules_revision, rules_digest, source_digest, rule_snapshot, source_snapshot, guidance_binding } = plan;
        const fingerprint = digest({ input, changes, blocked, rules_revision, rules_digest, source_digest, rule_snapshot, source_snapshot, ...(guidance_binding ? { guidance_binding } : {}) });
        if (fingerprint !== plan.digest || !approvedPlans.some(p => p.plan_id === plan.plan_id && p.digest === fingerprint)) throw new PlytixError('Saved batch plan digest differs from the exact approval');
      }
      if (record.state === 'complete') return record;
      if (record.state === 'stopped' && !record.errors.length && !record.bulk?.unresolved_errors &&
          record.outcomes.every(o => ['verified', 'unchanged', 'failed', 'conflict'].includes(o.status))) return record;
      if (record.retry_at && record.retry_at > Date.now()) { record.state = 'pending'; return record; }
      delete record.retry_at;
      const unknown = record.outcomes.some(o => o.status === 'sending_or_unknown');
      const queued = record.outcomes.filter(o => o.status === 'queued');
      if (write && queued.length && !record.bulk && !unknown) {
        phase = 'preflight';
        record.state = 'executing'; await persist();
        this.client.clearOperationReadCache();
        const snapshot = await this.pricing.batchSnapshot(plans, this.store);
        record.metrics.preflight_searches += snapshot.searchRequests;
        const conflicts = await this.pricing.checkBatch(plans, snapshot, new Set(queued.map(key)), this.store);
        for (const o of queued) if (conflicts.has(key(o))) { o.status = 'conflict'; o.message = conflicts.get(key(o)); }
        if (!record.baseline_id) {
          record.baseline_id = randomUUID();
          await this.store.create(`${record.baseline_id}.json`, { products: [...snapshot.products.values()], fields: [...snapshot.fields], configuration: configuration(snapshot) });
        }
        await persist();
        phase = 'execution';
        const ready = record.outcomes.filter(o => o.status === 'queued');
        if (ready.length && this.client.remainingOperationTimeMs() >= 5000) {
          if (record.transport !== 'patch' && record.used_transport !== 'patch') {
            const products = new Map<string, Record<string, number>>();
            for (const o of ready) {
              const c = record.changes.find(c => key(c) === key(o))!;
              const attributes = products.get(c.product_id) ?? {}; attributes[c.attribute] = c.new_value; products.set(c.product_id, attributes);
            }
            const rows = [...products].map(([id, attributes]) => ({ id, data: { attributes } }));
            const sent = await this.send(record, ready, persist, async () => {
              record.metrics.bulk_attempts++;
              const jobId = await this.client.submitPricingBulk(rows);
              record.used_transport = 'bulk'; record.bulk = { job_id: jobId, product_ids: [...products.keys()], settled: false, unresolved_errors: 0 };
            }, true);
            if (sent === 'fallback') record.used_transport = 'patch';
          } else record.used_transport = 'patch';
          if (record.used_transport === 'patch') {
            const owners = new Map<string, BatchOutcome[]>();
            for (const o of record.outcomes.filter(o => o.status === 'queued')) {
              const group = owners.get(o.product_id) ?? []; group.push(o); owners.set(o.product_id, group);
            }
            for (const [id, outcomes] of owners) {
              if (this.client.remainingOperationTimeMs() < 5000) break;
              const attributes = Object.fromEntries(outcomes.map(o => {
                const c = record.changes.find(c => key(c) === key(o))!; return [c.attribute, c.new_value];
              }));
              const sent = await this.send(record, outcomes, persist, async () => {
                record.metrics.patch_attempts++;
                await this.client.updateProduct(id, { attributes });
              }, false);
              if (sent === 'unknown' || sent === 'rate_limited') break;
            }
          }
        }
      }
      phase = 'validation';
      if (record.bulk && (!record.bulk.settled || record.bulk.unresolved_errors)) {
        const job = await this.client.getPricingBulkJob(record.bulk.job_id); record.metrics.polls++;
        record.bulk.status = typeof job.status === 'string' ? job.status.slice(0,80) : undefined;
        const counts = job.summary as Record<string, unknown> | undefined;
        const counter = (name: string) => { const n = Number(counts?.[name] ?? 0); return Number.isInteger(n) && n >= 0 ? n : NaN; };
        const total = counter('ok') + counter('error') + counter('cancelled');
        const failed = /^(failed|error|cancelled|canceled)$/i.test(String(job.status));
        if (total > record.bulk.product_ids.length) throw new PlytixError('Bulk job counters exceed the approved product count');
        record.bulk.settled = total === record.bulk.product_ids.length || failed;
        // Error details can lag counters. Affected rows are identified by exact
        // approved IDs/SKUs; no upstream message text is copied into the audit.
        if (Array.isArray(job.errors)) for (const row of job.errors) {
          const error = row as { id?: string; sku?: string };
          for (const c of record.changes.filter(c => c.product_id === error.id || (error.sku && c.sku === error.sku))) {
            const o = outcome(c.product_id, c.attribute); o.status = 'failed'; o.message = 'Plytix bulk job rejected this product; review its values before a new approval';
          }
        }
        const identified = new Set(record.outcomes.filter(o => o.status === 'failed' && record.bulk!.product_ids.includes(o.product_id)).map(o => o.product_id));
        const rejected = counter('error') + counter('cancelled');
        // A terminal job-wide failure does not prove which individual products
        // were written. Keep polling missing row results and never replay them.
        record.bulk.unresolved_errors = Math.max(0, (failed ? record.bulk.product_ids.length - counter('ok') : rejected) - identified.size);
        if (!Number.isFinite(record.bulk.unresolved_errors)) throw new PlytixError('Bulk job result counters are invalid');
        // Some successful Plytix jobs report Finished with absent/zero counters.
        // This only permits the normal full-baseline readback. It is not proof
        // of completion and never makes a submitted row eligible to resend.
        finishedWithoutCounters = /^finished$/i.test(String(job.status)) && total === 0 &&
          (job.errors == null || (Array.isArray(job.errors) && job.errors.length === 0)) && !record.bulk.unresolved_errors && !identified.size;
        await persist();
        if (!record.bulk.settled && !finishedWithoutCounters) { record.state = 'pending'; return record; }
      }
      const canVerify = record.outcomes.some(o => ['submitted', 'validation_pending', 'verified', 'failed'].includes(o.status) || (record.used_transport === 'patch' && o.status === 'sending_or_unknown'));
      if (canVerify && record.baseline_id && this.client.remainingOperationTimeMs() >= 1000) {
        const baseline = await this.store.read(`${record.baseline_id}.json`) as Baseline;
        this.client.clearOperationReadCache();
        const current = await this.pricing.batchSnapshot(plans, this.store); record.metrics.validation_searches += current.searchRequests;
        const configurationChanged = digest(baseline.configuration) !== digest(configuration(current));
        const projected = new Map(baseline.products.map(p => [p.id, structuredClone(p)]));
        for (const c of record.changes) {
          const o = outcome(c.product_id, c.attribute);
          if (!['submitted', 'verified', 'validation_pending', 'sending_or_unknown'].includes(o.status)) continue;
          for (const [id, value] of [[c.product_id, c.new_value], ...c.descendant_impact.map(d => [d.product_id, d.new_value])] as Array<[string, number]>) {
            const p = projected.get(id);
            if (p) { p.attributes ??= {}; p.attributes[c.attribute] = value; delete p[`attributes.${c.attribute}`]; }
          }
        }
        const mismatches = new Set<string>();
        const structural = ['id', 'sku', 'product_family_id', 'product_type', '_parent_id', 'num_variations', 'overwritten_attributes'];
        for (const [id, expected] of projected) {
          const actual = current.product(id);
          if (!actual || structural.some(a => digest(expected[a] ?? null) !== digest(actual[a] ?? null)) ||
              baseline.fields.some(a => digest(valueOf(expected, a) ?? null) !== digest(valueOf(actual, a) ?? null))) mismatches.add(id);
        }
        for (const id of current.products.keys()) if (!projected.has(id)) mismatches.add(id);
        const owned = new Set(record.changes.flatMap(c => [c.product_id, ...c.descendant_impact.map(d => d.product_id)]));
        record.errors = [...mismatches].filter(id => !owned.has(id)).map(id => `Unapproved product evidence changed: ${id}`);
        if (configurationChanged) record.errors.push('Family inheritance or target attribute schema changed during execution; inspect the current configuration');
        for (const c of record.changes) {
          const o = outcome(c.product_id, c.attribute);
          if (!['submitted', 'verified', 'validation_pending', 'sending_or_unknown'].includes(o.status)) continue;
          if (o.status === 'sending_or_unknown' && record.used_transport !== 'patch') continue;
          if (configurationChanged || [c.product_id, ...c.descendant_impact.map(d => d.product_id)].some(id => mismatches.has(id))) {
            if (o.status !== 'sending_or_unknown') o.status = 'validation_pending';
            o.message = 'Final values, inheritance or preserved fields differ; refresh validation without reposting';
          } else { o.status = 'verified'; delete o.message; }
        }
        if (finishedWithoutCounters && !record.errors.length && record.outcomes.every(o => ['verified', 'unchanged'].includes(o.status))) {
          record.bulk!.settled = true;
          record.bulk!.completion_evidence = 'verified_readback';
        }
      }
      if (record.bulk?.unresolved_errors) record.errors.push('Bulk job reports rejected or cancelled products whose row results are not available yet; refresh without reposting');
      record.state = record.outcomes.every(o => ['verified', 'unchanged'].includes(o.status)) && !record.errors.length && (!record.bulk || record.bulk.settled) ? 'complete'
        : record.outcomes.some(o => ['sending_or_unknown', 'failed', 'conflict'].includes(o.status)) || record.errors.length ? 'stopped' : 'pending';
      return record;
    } catch (error) {
      record.errors = [message(error)];
      if (phase === 'preflight' && !(error instanceof PlytixError && error.status === 429)) {
        for (const o of record.outcomes.filter(o => o.status === 'queued')) { o.status = 'conflict'; o.message = message(error); }
      }
      record.state = record.outcomes.some(o => ['sending_or_unknown', 'conflict', 'failed'].includes(o.status)) ? 'stopped' : 'pending';
      if (error instanceof PlytixError && error.status === 429) {
        record.metrics.rate_limit_errors++; record.retry_at = Date.now() + (error.retryAfterMs ?? 1000);
      }
      return record;
    } finally {
      // Lease expiration is the recovery boundary after a process/storage failure.
      delete record.lease_id; delete record.lease_until;
      await persist();
    }
  }

  private async send(record: BatchRecord, outcomes: BatchOutcome[], persist: () => Promise<void>, work: () => Promise<void>, bulk: boolean): Promise<'sent' | 'fallback' | 'failed' | 'unknown' | 'rate_limited'> {
    for (let attempt = 0; ; attempt++) {
      for (const o of outcomes) o.status = 'sending_or_unknown';
      await persist();
      try {
        await work();
        for (const o of outcomes) { o.status = 'submitted'; delete o.message; }
        await persist(); return 'sent';
      } catch (error) {
        const status = error instanceof PlytixError ? error.status : undefined;
        if (status === 429) {
          record.metrics.rate_limit_errors++;
          const delay = error instanceof PlytixError ? error.retryAfterMs ?? 1000 * 2 ** attempt : 1000;
          for (const o of outcomes) o.status = 'queued';
          record.retry_at = Date.now() + delay; await persist();
          if (attempt >= 2 || delay > 30_000 || this.client.remainingOperationTimeMs() < delay + 5000) return 'rate_limited';
          // No proactive pacing: wait only in response to a real rate-limit error.
          await new Promise(resolve => setTimeout(resolve, delay)); delete record.retry_at; continue;
        }
        if (bulk && record.transport === 'auto' && [403, 404, 405].includes(status ?? 0)) {
          for (const o of outcomes) o.status = 'queued'; await persist(); return 'fallback';
        }
        const rejected = status !== undefined && status >= 400 && status < 500 && status !== 408;
        for (const o of outcomes) { o.status = rejected ? 'failed' : 'sending_or_unknown'; o.message = message(error); }
        await persist(); return rejected ? 'failed' : 'unknown';
      }
    }
  }
}
