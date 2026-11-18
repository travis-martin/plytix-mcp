import { describe, expect, it } from 'vitest';
import { guidanceExclusion, guidanceInstruction, PricingGuidance } from '../pricing/guidance.js';
import { memoryValue, PricingMemory } from '../pricing/memory.js';
import { appendRecordProvenance, PROVENANCE_EVENTS_PER_RECORD, PROVENANCE_MAX_BYTES, provenanceDigest,
  recordProvenanceSchema, reviewMetadataSchema, type RecordProvenance } from '../pricing/provenance.js';
import type { PricingStore } from '../pricing/store.js';

class Store implements PricingStore {
  readonly kind = 'file' as const;
  records = new Map<string, unknown>();
  async read(key: string) { return structuredClone(this.records.get(key)); }
  async create(key: string, value: unknown) { this.records.set(key, structuredClone(value)); }
  async update<T>(key: string, parse: (value: unknown | undefined) => T, change: (value: T) => T) {
    const next = change(parse(await this.read(key))); this.records.set(key, structuredClone(next)); return next;
  }
}
const at = '2026-11-18T12:00:00.000Z';
const review = { sources: [{ kind: 'user' as const, reference: 'Owner decision 7, dated 2026-11-18' }],
  reason: 'Owner reviewed the corrected scope.', reviewer: 'Catalog owner' };
const instruction = guidanceInstruction.parse({ id: 'owner_rule', title: 'Owner restriction', text: 'Verify source units.',
  status: 'active', priority: 'required', source_ref: 'Legacy owner instruction' });
const exclusion = guidanceExclusion.parse({ id: 'custom_color', title: 'Custom pricing', status: 'active', family_ids: ['family-one'],
  all: [{ attribute: 'color', operator: 'equals', values: ['Custom'] }], reason: 'Use custom evidence.', source_ref: 'Owner decision 3' });
const value = memoryValue.parse({ kind: 'color', term: 'NAT', definition: 'Unpigmented source color.',
  scope: { supplier: 'Example supplier' }, attribute_labels: ['color'] });
const evidence = { source: 'document' as const, reference: 'Price list, page 1', source_sha256: 'a'.repeat(64) };

describe('server-authored pricing record provenance', () => {
  it('leaves untouched legacy history unknown, then captures exact prior content without invented attribution', async () => {
    const store = new Store();
    store.records.set('workflow.json', { version: 1, revision: 4, updated_at: '2026-11-01T12:00:00.000Z',
      instructions: [instruction], exclusions: [], history: [] });
    const guidance = new PricingGuidance(store, () => at);
    expect((await guidance.get()).record_provenance).toBeUndefined();
    const result = await guidance.save({ expected_revision: 4, instructions: [{ ...instruction, text: 'Verify price basis and source units.' }], exclusions: [] });
    const history = result.record_provenance!.records['instruction:owner_rule'];
    expect(history.origin).toBe('legacy_history_unknown');
    expect(history.events[0]).toMatchObject({ at, revision: 5, action: 'changed', operation: 'user_save', before: instruction });
    expect(history.events[0].review).toBeUndefined();
    expect(history.events[0].reviewer_identity).toBeUndefined();
    expect(history.events[0].before_digest).toBe(provenanceDigest(instruction));
  });

  it('keeps active protections until an explicitly sourced review accompanies any change', async () => {
    const store = new Store(), guidance = new PricingGuidance(store, () => at);
    await guidance.save({ expected_revision: 0, instructions: [], exclusions: [exclusion] });
    for (const changed of [{ ...exclusion, status: 'retired' as const }, { ...exclusion, target_attributes: ['cost'] },
      { ...exclusion, family_ids: ['another-family'] }, { ...exclusion, reason: 'Different reason' }]) {
      await expect(guidance.save({ expected_revision: 1, instructions: [], exclusions: [changed] })).rejects.toThrow('requires review sources');
      expect((await guidance.get()).exclusions).toEqual([exclusion]);
    }
    const result = await guidance.save({ expected_revision: 1, instructions: [], exclusions: [{ ...exclusion, status: 'retired' }], review });
    const history = result.record_provenance!.records['exclusion:custom_color'];
    expect(history.events).toHaveLength(2);
    expect(history.events[1]).toMatchObject({ action: 'retired', before: exclusion, review,
      reviewer_identity: 'caller_supplied_not_authenticated' });
    expect(history.events[0].after).toEqual(exclusion);
    expect((await guidance.get()).exclusions).toEqual([]);
  });

  it('does not accept caller-authored history, timestamps, or approval claims through save inputs', async () => {
    const guidance = new PricingGuidance(new Store(), () => at);
    const input = { expected_revision: 0, instructions: [instruction], exclusions: [] };
    await expect(guidance.save({ ...input, record_provenance: { version: 1, records: {}, omitted_records: 0 } } as never)).rejects.toThrow();
    await expect(guidance.save({ ...input, review: { ...review, approved: true } } as never)).rejects.toThrow();
    await expect(guidance.save({ ...input, review: { ...review, at: '2000-01-01T00:00:00.000Z' } } as never)).rejects.toThrow();
    expect(reviewMetadataSchema.safeParse({ ...review, sources: [] }).success).toBe(false);
    expect(reviewMetadataSchema.safeParse({ ...review, reviewer: '' }).success).toBe(false);
  });

  it('rejects persisted action contradictions and provenance for different current content', async () => {
    const store = new Store(), guidance = new PricingGuidance(store, () => at);
    const saved = await guidance.save({ expected_revision: 0, instructions: [instruction], exclusions: [] });
    const changedAction = structuredClone(saved.record_provenance!);
    changedAction.records['instruction:owner_rule'].events[0].action = 'removed';
    expect(recordProvenanceSchema.safeParse(changedAction).success).toBe(false);
    const raw = await store.read('workflow.json') as { instructions: typeof instruction[] };
    raw.instructions[0].text = 'A raw edit without a corresponding history event';
    store.records.set('workflow.json', raw);
    await expect(guidance.get()).rejects.toThrow('could not be read or validated');
  });

  it('records a supplied review without claiming that the reviewer name is authenticated', async () => {
    const guidance = new PricingGuidance(new Store(), () => at);
    await guidance.save({ expected_revision: 0, instructions: [instruction], exclusions: [] });
    const result = await guidance.save({ expected_revision: 1, instructions: [instruction], exclusions: [], review });
    const events = result.record_provenance!.records['instruction:owner_rule'].events;
    expect(events[1]).toMatchObject({ action: 'reviewed', review, before: instruction, after: instruction });
    expect(events[1].before_digest).toBe(events[1].after_digest);
    expect((await guidance.get()).provenance_authority).toContain('not authenticated identity');
  });

  it('preserves supplied dictionary evidence and distinguishes learning from user review', async () => {
    const store = new Store(), memory = new PricingMemory(store, () => at);
    await memory.record([value], evidence);
    const original = (await memory.get()).entries[0];
    const correctedEvidence = { source: 'user' as const, reference: 'Reviewed correction 9', source_sha256: 'b'.repeat(64) };
    await memory.update({ expected_revision: 1, entries: [{ value: { ...value, definition: 'Reviewed source-specific color meaning.' },
      status: 'user_defined', evidence: correctedEvidence }], review });
    await memory.record([value], { ...evidence, reference: 'New conflicting list, page 2' });
    const result = await memory.get();
    expect(result.entries[0].evidence.some(item => item.reference === correctedEvidence.reference)).toBe(true);
    const events = result.record_provenance!.records[`dictionary:${original.id}`].events;
    expect(events.map(item => item.operation)).toEqual(['automatic_observation', 'user_save', 'automatic_observation']);
    expect(events[0].review).toBeUndefined();
    expect(events[1].review).toEqual(review);
    expect(events[1].before).toEqual(original);
    expect(events[2].review).toBeUndefined();
    expect(events[2].after?.status).toBe('user_defined');
    expect(events[2].after?.pending).toBeDefined();
    const unchanged = await memory.record([value], { ...evidence, reference: 'New conflicting list, page 2' });
    expect(unchanged.revision).toBe(result.revision);
    expect((await memory.get()).record_provenance).toEqual(result.record_provenance);
  });

  it('returns dictionary provenance only for the requested page and scoped records', async () => {
    const memory = new PricingMemory(new Store(), () => at);
    await memory.record([value, { ...value, term: 'BLK' }], evidence);
    const page = await memory.get({ page_size: 1 });
    expect(Object.keys(page.record_provenance!.records)).toEqual([`dictionary:${page.entries[0].id}`]);
    expect(page.provenance_coverage).toBe('returned_records_only');
    const missing = await memory.get({ query: 'no-such-term' });
    expect(missing.record_provenance!.records).toEqual({});
  });

  it('does not attribute an unrelated retention removal to the reviewed correction', () => {
    const initial = appendRecordProvenance(undefined, { before: [], after: [
      { key: 'dictionary:old', value: { definition: 'An old observation' } },
    ], at, revision: 1, operation: 'automatic_observation' });
    const next = appendRecordProvenance(initial, { before: [
      { key: 'dictionary:old', value: { definition: 'An old observation' } },
    ], after: [{ key: 'dictionary:new', value: { definition: 'Explicit correction' } }],
    at, revision: 2, operation: 'user_save', review, review_keys: ['dictionary:new'] });
    expect(next!.records['dictionary:new'].events[0].review).toEqual(review);
    expect(next!.records['dictionary:old'].events[1].review).toBeUndefined();
    expect(next!.records['dictionary:old'].events[1].reviewer_identity).toBeUndefined();
  });

  it('retains changed source hashes for a pending conflict with the same source reference', async () => {
    const memory = new PricingMemory(new Store(), () => at);
    await memory.update({ expected_revision: 0, entries: [{ value, status: 'user_defined', evidence }] });
    const conflicting = { ...value, definition: 'Conflicting new source meaning.' };
    await memory.record([conflicting], evidence);
    const first = await memory.get();
    const changedEvidence = { ...evidence, source_sha256: 'c'.repeat(64) };
    await memory.record([conflicting], changedEvidence);
    const second = await memory.get();
    expect(second.revision).toBe(first.revision + 1);
    expect(second.entries[0].pending!.evidence.source_sha256).toBe(changedEvidence.source_sha256);
    await memory.update({ expected_revision: second.revision,
      entries: [{ value: conflicting, status: 'proposed', evidence: { ...evidence, source_sha256: 'd'.repeat(64) } }] });
    expect((await memory.get()).entries[0].pending!.evidence.source_sha256).toBe('d'.repeat(64));
  });

  it('retains a contiguous bounded suffix with full old/new snapshots and explicit truncation', () => {
    let provenance: RecordProvenance | undefined;
    for (let revision = 1; revision <= 20; revision++) {
      provenance = appendRecordProvenance(provenance, { before: revision === 1 ? [] : [{ key: 'rule:cost', value: { revision: revision - 1 } }],
        after: [{ key: 'rule:cost', value: { revision } }], at, revision, operation: 'user_save' });
    }
    const history = provenance!.records['rule:cost'];
    expect(history.events).toHaveLength(PROVENANCE_EVENTS_PER_RECORD);
    expect(history.dropped_events).toBe(4);
    expect(history.events[0]).toMatchObject({ sequence: 5, before: { revision: 4 }, after: { revision: 5 } });
    expect(recordProvenanceSchema.parse(JSON.parse(JSON.stringify(provenance)))).toEqual(provenance);
    const corrupt = structuredClone(provenance!);
    corrupt.records['rule:cost'].events[0].before = { revision: 999 };
    expect(recordProvenanceSchema.safeParse(corrupt).success).toBe(false);
    expect(() => appendRecordProvenance(provenance, { before: [{ key: 'rule:cost', value: { revision: 999 } }],
      after: [{ key: 'rule:cost', value: { revision: 21 } }], at, revision: 21, operation: 'user_save' })).toThrow('does not match');
  });

  it('bounds retained bytes while preserving the latest recoverable change', () => {
    const large = 'x'.repeat(600_000);
    let provenance: RecordProvenance | undefined;
    for (let revision = 1; revision <= 3; revision++) {
      provenance = appendRecordProvenance(provenance, { before: revision === 1 ? [] : [{ key: 'rule:cost', value: { text: large, revision: revision - 1 } }],
        after: [{ key: 'rule:cost', value: { text: large, revision } }], at, revision, operation: 'user_save' });
    }
    expect(Buffer.byteLength(JSON.stringify(provenance))).toBeLessThanOrEqual(PROVENANCE_MAX_BYTES);
    const history = provenance!.records['rule:cost'];
    expect(history.dropped_events).toBe(2);
    expect(history.events[0].before).toEqual({ text: large, revision: 2 });
    expect(history.events[0].after).toEqual({ text: large, revision: 3 });
    expect(() => appendRecordProvenance(undefined, { before: [], after: [{ key: 'rule:cost', value: { text: 'x'.repeat(PROVENANCE_MAX_BYTES) } }],
      at, revision: 1, operation: 'user_save' })).toThrow('retention limit');
  });

  it('does not allow automatic updates to assert a user review', () => {
    expect(() => appendRecordProvenance(undefined, { before: [], after: [{ key: 'rule:cost', value: { amount: 1 } }],
      at, revision: 1, operation: 'automatic_observation', review })).toThrow('cannot record a user review');
  });
});
