import { describe, expect, it } from 'vitest';
import { createPortableExport, refreshPortableExport, verifyPortableExport, portableContentDigest } from '../pricing/portable-export.js';
import { createImportCandidate, prepareReviewedImport, preflightReviewedImport } from '../pricing/reviewed-import.js';
import { memoryEntryId, memoryValue } from '../pricing/memory.js';
import { ruleSchema } from '../pricing/model.js';
import { appendRecordProvenance } from '../pricing/provenance.js';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const at = '2026-11-18T12:00:00.000Z', later = '2026-11-18T13:00:00.000Z';
const scope = { storage_scope: { mode: 'organization', workspace_id: 'example-account' }, storage_backend: 'gcs' };
const review = { sources: [{ kind: 'user' as const, reference: 'Owner decision 2026-11-18, record 3', observed_at: at }], reason: 'Correct the source meaning.', reviewer: 'Example reviewer' };
const envelope = <T>(tool: string, data: T) => ({ data, metadata: { tool, status: 'ok', generated_at: at } });
const rule = () => ruleSchema.parse({ id: 'sheet_rule', name: 'Sheet cost', status: 'proposed', evidence: 'Source price per complete sheet',
  family_ids: ['family-one'], target_attribute: 'supplier_cost', source_column: 'Cost', currency: 'USD', currency_column: 'Currency',
  unit: 'sheet', unit_column: 'Unit', operations: [], maximum: '10000', max_change_percent: 25,
  full_item_cost: { price_basis: 'item', price_unit: 'item', price_unit_column: 'Price unit', dimensions: [] },
});
function dictionaryEntry(index = 0) {
  const value = memoryValue.parse({ kind: 'color', term: `Natural ${index}`, definition: 'Source-specific color meaning.',
    scope: { source_namespace: 'Example list', family_id: 'family-one' }, attribute_labels: ['color_name'] });
  return { id: memoryEntryId(value), value, status: 'observed' as string, created_at: at, updated_at: at,
    evidence: [{ source: 'document' as const, reference: 'Example list, row 2', observed_at: at }], live_validation_required: true, stale_source: false };
}
function fixture() {
  const capture = {
    organization: 'Example', captured_at: at,
    workflow: envelope('pricing_guidance_get', { ...scope, version: 1, revision: 3, updated_at: at, digest: 'a'.repeat(64), complete_for_save: true, retained_history_revisions: 2,
      instructions: [{ id: 'owner', title: 'Check dimensions', text: 'Use full-item dimensions.', scope: { family_ids: [] }, status: 'active', priority: 'required', source_ref: 'Owner decision 1' }],
      exclusions: [{ id: 'protected_color', title: 'Protect custom color', status: 'active', family_ids: ['family-one'], target_attributes: [],
        all: [{ attribute: 'color_name', operator: 'equals', values: ['Custom'] }], reason: 'Custom item price.', source_ref: 'Owner decision 2' }],
    }),
    dictionary_pages: [envelope('pricing_dictionary_get', { ...scope, revision: 4, updated_at: at, entries: [dictionaryEntry()],
      total: 1, matched: 1, page: 1, page_size: 100, has_more: false, retained_history_revisions: 2 })],
    rules: envelope('pricing_rules_get', { ...scope, revision: 2, updated_at: at, rules: [rule()], history: [] }),
  };
  const baseline = createPortableExport(capture).document;
  const candidate = createImportCandidate(baseline);
  candidate.review = review;
  return { capture, baseline, candidate };
}

describe('reviewed organization imports', () => {
  it('drafts editable data without copying status/history metadata into mutation inputs', () => {
    const input = fixture();
    expect(input.candidate.base_export_sha256).toBe(input.baseline.integrity.sha256);
    expect(input.candidate.dictionary?.[0]).not.toHaveProperty('updated_at');
    expect(input.candidate.dictionary?.[0]).not.toHaveProperty('pending');
    expect(input.candidate).not.toHaveProperty('record_provenance');
    expect(prepareReviewedImport(input).calls).toEqual([]);
  });

  it('produces reviewable protection and workflow changes using exact current revisions', () => {
    const input = fixture();
    input.candidate.workflow!.instructions[0].text = 'Read the current full-item dimensions and verify units.';
    input.candidate.workflow!.exclusions[0].status = 'retired';
    const prepared = prepareReviewedImport(input);
    expect(prepared.calls).toHaveLength(1);
    expect(prepared.calls[0]).toMatchObject({ tool: 'pricing_guidance_save', arguments: { expected_revision: 3, review } });
    expect(prepared.changes.find(item => item.section === 'exclusions')).toMatchObject({ change: 'retired', flags: expect.arrayContaining(['EXPLICIT_RETIREMENT']) });
    expect(prepared.changes.some(item => item.flags.some(flag => flag.startsWith('PROTECTION_CHANGED')))).toBe(true);
    const preflight = preflightReviewedImport({ review: prepared, reviewed_digest: prepared.review_digest, capture: input.capture });
    expect(preflight.status).toBe('ready_for_existing_host_approval');
    expect(preflight.calls).toEqual(prepared.calls);
  });

  it('requires source/reason review metadata and forbids implicit workflow removals', () => {
    const noReview = fixture(); noReview.candidate.review = undefined;
    noReview.candidate.workflow!.instructions[0].text = 'Changed requirement.';
    expect(() => prepareReviewedImport(noReview)).toThrow('structured review sources');
    const missingInstruction = fixture(); missingInstruction.candidate.workflow!.instructions = [];
    expect(() => prepareReviewedImport(missingInstruction)).toThrow('Preserve every workflow ID');
    const missingExclusion = fixture(); missingExclusion.candidate.workflow!.exclusions = [];
    expect(() => prepareReviewedImport(missingExclusion)).toThrow('Preserve every workflow ID');
  });

  it('supports subset sections while dictionary omission leaves existing entries unchanged', () => {
    const input = fixture();
    input.candidate.workflow = undefined; input.candidate.rules = undefined; input.candidate.dictionary = [];
    expect(prepareReviewedImport(input).calls).toEqual([]);
  });

  it('rejects corrupted exports, cross-organization imports and stale baselines', () => {
    const corrupted = fixture(); corrupted.baseline.workflow.instructions[0].text = 'Tampered baseline';
    expect(() => prepareReviewedImport(corrupted)).toThrow('checksum');
    const wrongBase = fixture(); wrongBase.candidate.base_export_sha256 = 'f'.repeat(64);
    expect(() => prepareReviewedImport(wrongBase)).toThrow('verified baseline');
    const crossOrg = fixture();
    crossOrg.capture.workflow.data.storage_scope = { mode: 'organization', workspace_id: 'other-account' };
    crossOrg.capture.dictionary_pages[0].data.storage_scope = { mode: 'organization', workspace_id: 'other-account' };
    crossOrg.capture.rules.data.storage_scope = { mode: 'organization', workspace_id: 'other-account' };
    expect(() => prepareReviewedImport(crossOrg)).toThrow('cross organization');
    const stale = fixture(); stale.capture.dictionary_pages[0].data.revision++;
    expect(() => prepareReviewedImport(stale)).toThrow('baseline is stale');
    const hiddenEdit = fixture(); hiddenEdit.capture.workflow.data.instructions[0].text = 'Changed at same revision';
    expect(() => prepareReviewedImport(hiddenEdit)).toThrow('baseline is stale');
  });

  it('imports changed observations as proposed and rejects dictionary identity spoofing', () => {
    const input = fixture(); input.candidate.dictionary![0].value.definition = 'Clarified observed meaning.';
    const result = prepareReviewedImport(input);
    expect(result.calls[0]).toMatchObject({ tool: 'pricing_dictionary_update', arguments: { expected_revision: 4,
      entries: [{ status: 'proposed', value: { definition: 'Clarified observed meaning.' } }] } });
    expect(result.changes[0].flags.some(flag => flag.startsWith('ADVISORY_IMPORT'))).toBe(true);
    const identity = fixture(); identity.candidate.dictionary![0].value.scope.family_id = 'different-family';
    expect(() => prepareReviewedImport(identity)).toThrow('Dictionary identity changed');
  });

  it('requires deliberate user-defined decisions with user evidence and keeps protected suggestions pending', () => {
    const input = fixture(); input.candidate.dictionary![0].status = 'user_defined';
    expect(() => prepareReviewedImport(input)).toThrow('per-ID decision');
    input.candidate.decisions.user_defined_dictionary_ids = [input.candidate.dictionary![0].id];
    expect(() => prepareReviewedImport(input)).toThrow('user source evidence');
    input.candidate.dictionary![0].evidence = { source: 'user', reference: 'Owner reviewed meaning, decision 3' };
    expect(prepareReviewedImport(input).calls[0]).toMatchObject({ arguments: { entries: [{ status: 'user_defined' }] } });

    const protectedEntry = fixture(); protectedEntry.capture.dictionary_pages[0].data.entries[0].status = 'user_defined';
    protectedEntry.baseline = createPortableExport(protectedEntry.capture).document;
    protectedEntry.candidate = createImportCandidate(protectedEntry.baseline); protectedEntry.candidate.review = review;
    protectedEntry.candidate.dictionary![0].status = 'proposed'; protectedEntry.candidate.dictionary![0].value.definition = 'Unreviewed alternative.';
    expect(prepareReviewedImport(protectedEntry).changes[0].flags.some(flag => flag.startsWith('PENDING_ONLY'))).toBe(true);
  });

  it('rejects stored timestamps, provenance, pending state and approval flags in candidate data', () => {
    for (const unexpected of [{ record_provenance: {} }, { approved: true }, { history: [] }]) {
      const input = fixture(); Object.assign(input.candidate, unexpected);
      expect(() => prepareReviewedImport(input)).toThrow();
    }
    const record = fixture(); Object.assign(record.candidate.dictionary![0], { updated_at: later });
    expect(() => prepareReviewedImport(record)).toThrow();
  });

  it('requires explicit rule removals and never trusts a copied confirmed status', () => {
    const removed = fixture(); removed.candidate.rules!.current = [];
    expect(() => prepareReviewedImport(removed)).toThrow('explicit remove_rule_ids');
    removed.candidate.rules!.remove_rule_ids = ['sheet_rule'];
    expect(prepareReviewedImport(removed).changes[0]).toMatchObject({ section: 'rules', change: 'removed' });
    const copied = fixture(); copied.candidate.rules!.current[0].status = 'confirmed'; copied.candidate.rules!.current[0].name = 'Changed rule';
    const proposed = prepareReviewedImport(copied);
    expect(proposed.calls[0]).toMatchObject({ arguments: { rules: [{ status: 'proposed' }] } });
    expect(proposed.warnings.some(item => item.includes('copied confirmed status'))).toBe(true);
    copied.candidate.decisions.confirm_rule_ids = ['sheet_rule'];
    expect(prepareReviewedImport(copied).calls[0]).toMatchObject({ arguments: { rules: [{ status: 'confirmed' }] } });
  });

  it('applies reusable supplier-cost validation against actual destination rules', () => {
    const input = fixture();
    const costRule = input.candidate.rules!.current[0];
    costRule.target_attribute = 'supplier_1_cost'; costRule.full_item_cost = undefined;
    expect(() => prepareReviewedImport(input)).toThrow('full_item_cost');
    costRule.full_item_cost = { price_basis: 'item', price_unit: 'item', price_unit_column: 'Price unit', dimensions: [] };
    costRule.operations = [{ op: 'multiply', operand: '10' }];
    expect(() => prepareReviewedImport(input)).toThrow('pricing_adjustment');
    costRule.operations = [];
    expect(prepareReviewedImport(input).calls[0].tool).toBe('pricing_rules_save');
  });

  it('batches dictionary changes by byte limit and count with exact sequential revisions', () => {
    const input = fixture();
    input.capture.dictionary_pages[0].data.entries = Array.from({ length: 60 }, (_, i) => dictionaryEntry(i));
    Object.assign(input.capture.dictionary_pages[0].data, { total: 60, matched: 60 });
    input.baseline = createPortableExport(input.capture).document; input.candidate = createImportCandidate(input.baseline); input.candidate.review = review;
    for (const item of input.candidate.dictionary!) item.value.definition = 'Meaning '.repeat(140);
    const calls = prepareReviewedImport(input).calls;
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.map(call => call.arguments.expected_revision)).toEqual(calls.map((_, i) => 4 + i));
    expect(calls.every(call => Buffer.byteLength(JSON.stringify(call.arguments), 'utf8') <= 16000)).toBe(true);
    expect(calls.reduce((count, call) => count + (call.tool === 'pricing_dictionary_update' ? call.arguments.entries.length : 0), 0)).toBe(60);
  });

  it('preflight rejects altered calls, unreviewed digest and newly changed sources', () => {
    const input = fixture(); input.candidate.workflow!.instructions[0].text = 'New instruction.';
    const prepared = prepareReviewedImport(input);
    expect(() => preflightReviewedImport({ review: prepared, reviewed_digest: 'f'.repeat(64), capture: input.capture })).toThrow('digest mismatch');
    const tampered = structuredClone(prepared); tampered.calls[0].arguments.expected_revision++;
    expect(() => preflightReviewedImport({ review: tampered, reviewed_digest: prepared.review_digest, capture: input.capture })).toThrow('digest mismatch');
    input.capture.workflow.data.revision++;
    expect(() => preflightReviewedImport({ review: prepared, reviewed_digest: prepared.review_digest, capture: input.capture })).toThrow('baseline is stale');
  });
});

describe('portable export refresh', () => {
  it('skips unchanged content despite newer read/capture times', () => {
    const input = fixture(); input.capture.captured_at = later;
    for (const result of [input.capture.workflow, input.capture.rules, ...input.capture.dictionary_pages]) result.metadata.generated_at = later;
    const refreshed = refreshPortableExport(input.baseline, input.capture);
    expect(refreshed).toMatchObject({ changed: false, document: null, markdown: null, changes: [] });
  });

  it('records predecessor checksums, source revisions and precise record changes', () => {
    const input = fixture(); input.capture.captured_at = later;
    input.capture.workflow.data.revision++; input.capture.workflow.data.instructions[0].text = 'Revised requirement.';
    input.capture.workflow.data.exclusions[0].status = 'retired';
    const refreshed = refreshPortableExport(input.baseline, input.capture);
    expect(refreshed.changed).toBe(true);
    expect(refreshed.document?.lineage).toMatchObject({ predecessor_sha256: input.baseline.integrity.sha256,
      predecessor_revisions: { workflow: 3, dictionary: 4, rules: 2 } });
    expect(refreshed.changes.map(item => item.change)).toEqual(['changed', 'retired']);
    expect(verifyPortableExport(JSON.parse(JSON.stringify(refreshed.document)))).toEqual(refreshed.document);
    expect(refreshed.markdown).toContain('Export refresh lineage');
  });

  it('rejects predecessor tampering and source rollback', () => {
    const input = fixture(); input.capture.workflow.data.revision--;
    expect(() => refreshPortableExport(input.baseline, input.capture)).toThrow('roll back');
    input.baseline.organization.display_name = 'Tampered';
    expect(() => refreshPortableExport(input.baseline, input.capture)).toThrow('checksum');
  });

  it('preserves validated per-record history without promoting reviewer identity', () => {
    const input = fixture();
    const instruction = input.capture.workflow.data.instructions[0];
    const record_provenance = appendRecordProvenance(undefined, { before: [], after: [{ key: `instruction:${instruction.id}`, value: instruction }],
      at, revision: 3, operation: 'user_save', review, review_keys: [`instruction:${instruction.id}`] });
    Object.assign(input.capture.workflow.data, { record_provenance });
    const exported = createPortableExport(input.capture);
    expect(exported.document.workflow.record_provenance).toEqual(record_provenance);
    expect(exported.markdown).toContain('caller_supplied_not_authenticated');
    expect(exported.markdown).toContain('Owner decision 2026-11-18');
    const verified = verifyPortableExport(exported.document);
    const { integrity, ...payload } = verified;
    expect(portableContentDigest(payload)).toBe(integrity.sha256);
    expect(createImportCandidate(exported.document).workflow).not.toHaveProperty('record_provenance');
  });
});

describe('offline import and refresh CLIs', () => {
  it('runs draft, prepare, preflight and immutable refresh without a network connection', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'pricing-portable-'));
    const run = (script: string, args: string[]) => spawnSync(process.execPath,
      ['--import', 'tsx', resolve(`src/pricing/${script}`), ...args], { encoding: 'utf8', timeout: 10000 });
    try {
      const input = fixture(); input.candidate.workflow!.instructions[0].text = 'Reviewed changed requirement.';
      const baselineFile = join(folder, 'baseline.json'), candidateFile = join(folder, 'candidate.json'), captureFile = join(folder, 'capture.json');
      await writeFile(baselineFile, JSON.stringify(input.baseline)); await writeFile(candidateFile, JSON.stringify(input.candidate));
      await writeFile(captureFile, JSON.stringify(input.capture));
      const draftDir = join(folder, 'draft');
      expect(run('import-cli.ts', ['--mode', 'draft', '--baseline', baselineFile, '--output', draftDir]).status).toBe(0);
      expect(JSON.parse(await readFile(join(draftDir, 'import-candidate.json'), 'utf8')).base_export_sha256).toBe(input.baseline.integrity.sha256);
      const reviewDir = join(folder, 'review');
      expect(run('import-cli.ts', ['--mode', 'prepare', '--baseline', baselineFile, '--candidate', candidateFile, '--capture', captureFile, '--output', reviewDir]).status).toBe(0);
      const reviewFile = join(reviewDir, 'reviewed-import.json'), prepared = JSON.parse(await readFile(reviewFile, 'utf8'));
      const readyDir = join(folder, 'ready');
      const preflightArgs = ['--mode', 'preflight', '--review', reviewFile, '--reviewed-digest', prepared.review_digest, '--capture', captureFile, '--output', readyDir];
      expect(run('import-cli.ts', preflightArgs).status).toBe(0);
      const readyFile = join(readyDir, 'preflight-tool-calls.json'), firstReady = await readFile(readyFile, 'utf8');
      expect(JSON.parse(firstReady).status).toBe('ready_for_existing_host_approval');
      expect(run('import-cli.ts', preflightArgs).status).toBe(1);
      expect(await readFile(readyFile, 'utf8')).toBe(firstReady);

      const unchangedDir = join(folder, 'unchanged');
      expect(run('export-cli.ts', ['--input', captureFile, '--previous', baselineFile, '--output', unchangedDir]).status).toBe(0);
      await expect(access(unchangedDir)).rejects.toThrow();
      input.capture.workflow.data.revision++; input.capture.workflow.data.instructions[0].text = 'Published new requirement.';
      await writeFile(captureFile, JSON.stringify(input.capture));
      const refreshDir = join(folder, 'refresh');
      expect(run('export-cli.ts', ['--input', captureFile, '--previous', baselineFile, '--output', refreshDir]).status).toBe(0);
      const refreshed = verifyPortableExport(JSON.parse(await readFile(join(refreshDir, 'organization-knowledge.json'), 'utf8')));
      expect(refreshed.lineage?.predecessor_sha256).toBe(input.baseline.integrity.sha256);
      expect(refreshed.lineage?.changes).toHaveLength(1);
    } finally {
      if (dirname(resolve(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('pricing-portable-')) throw new Error('Unexpected fixture cleanup path');
      await rm(folder, { recursive: true, force: true });
    }
  }, 30000);
});
