import { describe, expect, it } from 'vitest';
import { applicableInstructions, evaluatePricingExclusions, guidanceDigest, guidanceDocument, guidanceExclusion, guidanceInstruction,
  hasActiveGuidance, PricingGuidance, readGuidance } from '../pricing/guidance.js';
import type { PricingStore } from '../pricing/store.js';
import type { PlytixProduct } from '../types.js';

class MemoryStore implements PricingStore {
  readonly kind = 'file' as const;
  values = new Map<string, unknown>();
  async read(key: string) { return structuredClone(this.values.get(key)); }
  async create(key: string, value: unknown) { if (this.values.has(key)) throw new Error('Exists'); this.values.set(key, structuredClone(value)); }
  async update<T>(key: string, parse: (value: unknown | undefined) => T, change: (value: T) => T): Promise<T> {
    const value = change(parse(await this.read(key))); this.values.set(key, structuredClone(value)); return value;
  }
}
const instruction = guidanceInstruction.parse({ id: 'preserve_primary', title: 'Keep the selected supplier',
  text: 'Do not change the primary supplier without separate permission.', priority: 'required', status: 'active',
  source_ref: 'Explicit owner workflow requirement' });
const exclusion = guidanceExclusion.parse({ id: 'custom_color', title: 'Custom-priced color', status: 'active',
  family_ids: ['family-017'], target_attributes: [], all: [{ attribute: 'color_name', operator: 'equals', values: ['Purple/White/Purple'] }],
  reason: 'This custom color must not inherit ordinary supplier-list pricing.', source_ref: 'Explicit owner instruction' });
const document = (instructions = [instruction], exclusions = [exclusion]) => guidanceDocument.parse({ version: 1, revision: 1,
  updated_at: '2026-11-03T12:00:00.000Z', instructions, exclusions, history: [] });
const product = (color: unknown = 'Purple/White/Purple', family = 'family-017'): PlytixProduct => ({
  id: 'owner', sku: 'FIXTURE', product_family_id: family, product_type: 'VARIANT', num_variations: 0,
  attributes: { color_name: color },
});

describe('protected pricing workflow guidance', () => {
  it('returns an empty policy without storage mutations or business-specific defaults', async () => {
    const store = new MemoryStore(), policy = await readGuidance(store);
    expect(policy).toMatchObject({ revision: 0, instructions: [], exclusions: [] });
    expect(hasActiveGuidance(policy)).toBe(false);
    expect(store.values.size).toBe(0);
    expect((await new PricingGuidance(store).get()).exclusions).toEqual([]);
  });

  it('saves explicit instructions and exclusions with revision protection and prior snapshots', async () => {
    const store = new MemoryStore(), guidance = new PricingGuidance(store, () => '2026-11-03T12:00:00.000Z');
    const first = await guidance.save({ expected_revision: 0, instructions: [instruction], exclusions: [exclusion] });
    expect(first.revision).toBe(1); expect(first.history).toEqual([]);
    const next = await guidance.save({ expected_revision: 1, instructions: [{ ...instruction, text: 'An explicit corrected instruction.' }], exclusions: [exclusion] });
    expect(next.history[0].instructions[0].text).toBe(instruction.text);
    expect(next.digest).not.toBe(first.digest);
    await expect(guidance.save({ expected_revision: 1, instructions: [], exclusions: [] })).rejects.toThrow('latest revision');
    expect((await guidance.get()).instructions[0].text).toBe('An explicit corrected instruction.');
  });

  it('rejects duplicate IDs and unsupported executable fields without changing saved guidance', async () => {
    const store = new MemoryStore(), guidance = new PricingGuidance(store);
    await expect(guidance.save({ expected_revision: 0, instructions: [instruction, instruction], exclusions: [] })).rejects.toThrow('unique');
    await expect(guidance.save({ expected_revision: 0, instructions: [], exclusions: [{ ...exclusion, all: [exclusion.all[0], exclusion.all[0]] }] })).rejects.toThrow('unique');
    expect(guidanceExclusion.safeParse({ ...exclusion, script: 'run arbitrary code' }).success).toBe(false);
    expect(guidanceExclusion.safeParse({ ...exclusion, all: [{ attribute: 'color_name', operator: 'contains', values: ['Purple'] }] }).success).toBe(false);
    expect(store.values.size).toBe(0);
  });

  it('does not let a partial read silently remove protected guidance and marks complete edit payloads', async () => {
    const store = new MemoryStore(), guidance = new PricingGuidance(store);
    await guidance.save({ expected_revision: 0, instructions: [instruction], exclusions: [exclusion] });
    expect((await guidance.get()).complete_for_save).toBe(false);
    expect((await guidance.get({ include_retired: true })).complete_for_save).toBe(true);
    expect((await guidance.get({ include_retired: true, family_ids: ['family-017'] })).complete_for_save).toBe(false);
    await expect(guidance.save({ expected_revision: 1, instructions: [], exclusions: [exclusion] })).rejects.toThrow('retired');
    const saved = await guidance.save({ expected_revision: 1, instructions: [{ ...instruction, status: 'retired' }], exclusions: [exclusion] });
    expect(saved.instructions[0].status).toBe('retired');
    await expect(guidance.save({ expected_revision: 2, instructions: [], exclusions: [exclusion] })).rejects.toThrow('retired');
  });

  it('surfaces global requirements and scoped instructions without hiding unknown source context', () => {
    const scoped = { ...instruction, id: 'source_only', scope: { family_ids: ['family-017'], source_context: { supplier: 'Supplier A' } } };
    const other = { ...instruction, id: 'other_family', scope: { family_ids: ['family-014'] } };
    const retired = { ...instruction, id: 'retired', status: 'retired' as const };
    const policy = document([scoped, other, retired, instruction]);
    expect(applicableInstructions(policy, { family_ids: ['family-017'] }).map(item => item.id)).toEqual(['preserve_primary', 'source_only']);
    expect(applicableInstructions(policy, { family_ids: ['family-017'], source_context: { supplier: 'Supplier B' } }).map(item => item.id)).toEqual(['preserve_primary']);
    expect(applicableInstructions(policy, { family_ids: ['family-017'], source_context: { supplier: ' supplier a ' } }).map(item => item.id)).toEqual(['preserve_primary', 'source_only']);
    expect(applicableInstructions(policy, { include_retired: true })).toHaveLength(4);
  });

  it('blocks custom-color pricing across all pricing targets regardless of thickness', () => {
    for (const label of ['supplier_1_cost', 'supplier_4_cost', 'price']) {
      const candidate = product(' purple/white/purple '); candidate.attributes!.nominal_thickness = '3/4';
      const result = evaluatePricingExclusions(document(), candidate, label);
      expect(result.blocked[0]).toMatchObject({ id: 'custom_color' });
      expect(result.evidence.color_name).toBe(' purple/white/purple ');
    }
    expect(evaluatePricingExclusions(document(), product('Black'), 'supplier_1_cost').blocked).toEqual([]);
    expect(evaluatePricingExclusions(document(), product('Purple/White/Purple', 'other-family'), 'supplier_1_cost').blocked).toEqual([]);
  });

  it('honors exact target-attribute scopes and retirement without silently weakening saved records', () => {
    const scoped = document([], [{ ...exclusion, target_attributes: ['supplier_1_cost'] }]);
    expect(evaluatePricingExclusions(scoped, product(), 'supplier_1_cost').blocked).toHaveLength(1);
    expect(evaluatePricingExclusions(scoped, product(), 'supplier_2_cost').blocked).toEqual([]);
    const retired = document([], [{ ...exclusion, status: 'retired' }]);
    expect(hasActiveGuidance(retired)).toBe(false);
    expect(evaluatePricingExclusions(retired, product(), 'supplier_1_cost').blocked).toEqual([]);
    expect(retired.exclusions).toHaveLength(1);
  });

  it.each([undefined, null, '', '  ', [], {}, NaN])('fails closed for unknown matching evidence %j', value => {
    const candidate = product(); candidate.attributes!.color_name = value;
    const result = evaluatePricingExclusions(document(), candidate, 'supplier_1_cost');
    expect(result.blocked[0].reason).toContain('Cannot determine');
  });

  it('uses known-false AND predicates to prove nonmatching scope while retaining incomplete evidence', () => {
    const policy = document([], [{ ...exclusion, all: [exclusion.all[0], { attribute: 'grade', operator: 'equals', values: ['Custom'] }] }]);
    const candidate = product(undefined); candidate.attributes = { grade: 'Standard' };
    const result = evaluatePricingExclusions(policy, candidate, 'supplier_1_cost');
    expect(result.blocked).toEqual([]); expect(result.evidence).toEqual({ color_name: null, grade: 'Standard' });
    candidate.attributes.grade = 'Custom';
    expect(evaluatePricingExclusions(policy, candidate, 'supplier_1_cost').blocked[0].reason).toContain('Cannot determine');
  });

  it('matches numbers exactly and fails closed on changed types without coercing numeric strings', () => {
    const policy = document([], [{ ...exclusion, all: [{ attribute: 'size', operator: 'in', values: [0.5, 0.75] }] }]);
    const candidate = product(); candidate.attributes!.size = 0.5;
    expect(evaluatePricingExclusions(policy, candidate, 'cost').blocked).toHaveLength(1);
    candidate.attributes!.size = '0.5';
    expect(evaluatePricingExclusions(policy, candidate, 'cost').blocked[0].reason).toContain('Cannot determine');
    expect(guidanceExclusion.safeParse({ ...exclusion, all: [{ attribute: 'size', operator: 'equals', values: [0.5, 0.75] }] }).success).toBe(false);
    expect(guidanceExclusion.safeParse({ ...exclusion, all: [{ attribute: 'size', operator: 'in', values: [0.5, '0.75'] }] }).success).toBe(false);
  });

  it('uses flat attribute fields and changes digest on edits but not unrelated history metadata', () => {
    const candidate = product('Black'); candidate['attributes.color_name'] = 'Purple/White/Purple';
    expect(evaluatePricingExclusions(document(), candidate, 'cost').blocked).toHaveLength(1);
    const a = document(), b = structuredClone(a); b.updated_at = '2026-11-04T00:00:00.000Z';
    expect(guidanceDigest(a)).toBe(guidanceDigest(b));
    b.exclusions[0].reason = 'A newly reviewed business reason.';
    expect(guidanceDigest(a)).not.toBe(guidanceDigest(b));
  });

  it('rejects malformed persisted guidance rather than treating it as empty policy', async () => {
    const store = new MemoryStore(); store.values.set('workflow.json', { instructions: [] });
    await expect(readGuidance(store)).rejects.toThrow('could not be read');
    store.values.set('workflow.json', { ...document(), instructions: [instruction, instruction] });
    await expect(readGuidance(store)).rejects.toThrow('could not be read');
  });

  it('retains current protected instructions while bounding correction history', async () => {
    const store = new MemoryStore(), guidance = new PricingGuidance(store);
    for (let revision = 0; revision < 24; revision++) {
      await guidance.save({ expected_revision: revision, instructions: [{ ...instruction, text: `Revision ${revision}` }], exclusions: [exclusion] });
    }
    const current = await guidance.read();
    expect(current.history).toHaveLength(20);
    expect(current.instructions[0].text).toBe('Revision 23');
    expect(current.exclusions[0]).toEqual(exclusion);
  });
});
