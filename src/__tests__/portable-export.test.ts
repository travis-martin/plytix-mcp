import { describe, expect, it } from 'vitest';
import { createPortableExport, portableContentDigest } from '../pricing/portable-export.js';
import { guidanceDigest } from '../pricing/guidance.js';
import { ruleSchema } from '../pricing/model.js';

const at = '2026-11-18T12:00:00.000Z';
const stored = { storage_scope: { mode: 'organization', workspace_id: 'example-catalog' }, storage_backend: 'gcs' };
function wrap<T>(tool: string, data: T) {
  return { data, metadata: { tool, status: 'ok', generated_at: at } };
}
function entry(id = 'a', status = 'user_defined') {
  return {
    id: id.repeat(64), value: { kind: 'color', term: 'Natural', definition: 'Use this meaning only for this source.',
      scope: { supplier: 'Example Supplier', family_id: 'family-one' }, canonical_term: 'Unpigmented', attribute_labels: ['color'] },
    status, created_at: at, updated_at: at,
    evidence: [{ source: 'user', reference: 'Owner instruction dated 2026-11-18, decision 3', observed_at: at }],
    live_validation_required: true, stale_source: false,
  };
}
function fixture() {
  return {
    organization: 'Example Organization', captured_at: at, knowledge_status: { configured: false }, provenance_notes: ['Source archive: owner instructions, decision 3.'],
    workflow: wrap('pricing_guidance_get', {
      ...stored, version: 1, revision: 4, updated_at: at, digest: 'b'.repeat(64), complete_for_save: true, retained_history_revisions: 3,
      instructions: [{ id: 'owner_rule', title: 'Protect custom pricing', text: 'Do not replace custom color pricing with standard prices.',
        scope: { family_ids: ['family-one'] }, priority: 'required', status: 'active', source_ref: 'Explicit instructions in this conversation' }],
      exclusions: [{ id: 'custom_color', title: 'Custom color', status: 'active', family_ids: ['family-one'], target_attributes: [],
        all: [{ attribute: 'color', operator: 'equals', values: ['Custom'] }], reason: 'Separate pricing applies.', source_ref: 'Owner instruction 3' }],
    }),
    dictionary_pages: [wrap('pricing_dictionary_get', { ...stored, revision: 5, updated_at: at, entries: [entry()],
      total: 1, matched: 1, page: 1, page_size: 100, has_more: false, retained_history_revisions: 2 })],
    rules: wrap('pricing_rules_get', { ...stored, revision: 2, updated_at: at, rules: [], history: [{ revision: 1, updated_at: at,
      rules: [ruleSchema.parse({ id: 'old_rule', name: 'One-run list rule', status: 'confirmed', evidence: 'Past approved batch', family_ids: ['family-one'],
        target_attribute: 'supplier_cost', source_column: 'Cost', currency: 'USD', currency_column: 'Currency', unit: 'sheet', unit_column: 'Unit',
        operations: [{ op: 'multiply', operand: '10' }], maximum: '1000', max_change_percent: 10 })] }] }),
  };
}

describe('portable organization pricing export', () => {
  it('keeps scope, statuses, exact instructions and inactive history with explicit portability limits', () => {
    const input = fixture();
    const { document, markdown } = createPortableExport(input);
    expect(document.organization.workspace_id).toBe('example-catalog');
    expect(document.workflow.instructions[0].text).toBe(input.workflow.data.instructions[0].text);
    expect(document.dictionary.entries[0].value.scope).toEqual(input.dictionary_pages[0].data.entries[0].value.scope);
    expect(document.calculation_rules.current).toEqual([]);
    expect(document.calculation_rules.history_not_active[0].rules[0].status).toBe('confirmed');
    expect(markdown).toContain('Historical calculation rules — NOT ACTIVE');
    expect(markdown).toContain('ALL numeric pricing-workflow targets');
    expect(markdown).toContain('missing, blank, non-finite, non-scalar or wrong-type evidence blocks');
    expect(markdown).toContain('every inheriting descendant');
    expect(markdown).toContain('does not enforce exclusions');
    expect(markdown).toContain('stale_source=false does not certify freshness');
    expect(document.coverage.catalog_facts_verified).toBe(false);
    expect(document.coverage.transactional_snapshot).toBe(false);
    expect(document.warnings.some(value => value.includes('context-dependent'))).toBe(true);
    expect(document.warnings.some(value => value.includes('unconfigured'))).toBe(true);
  });

  it('includes the source digest as a receipt even when read order differs from stored order', () => {
    const input = fixture();
    const second = { ...input.workflow.data.instructions[0], id: 'second_rule', title: 'Second', priority: 'recommended' };
    input.workflow.data.instructions.push(second);
    input.workflow.data.digest = guidanceDigest({ ...input.workflow.data,
      instructions: input.workflow.data.instructions as never, exclusions: input.workflow.data.exclusions as never,
      version: 1, history: [] });
    input.workflow.data.instructions.reverse();
    const { document } = createPortableExport(input);
    expect(document.source.workflow.digest).toBe(input.workflow.data.digest);
    expect(document.workflow.instructions.map(item => item.id)).toEqual(['second_rule', 'owner_rule']);
  });

  it('hashes the allowlisted payload reproducibly and excludes incidental configuration', () => {
    const input = fixture();
    Object.assign(input, { password: 'private-secret' });
    Object.assign(input.workflow.data, { credential_fingerprint: 'private-fingerprint' });
    Object.assign(input.workflow.metadata, { authorization: 'private-token' });
    const first = createPortableExport(input);
    const { integrity, ...payload } = first.document;
    expect(integrity.sha256).toBe(portableContentDigest(payload));
    expect(createPortableExport(input).document.integrity.sha256).toBe(integrity.sha256);
    expect(JSON.stringify(first)).not.toContain('private-secret');
    expect(JSON.stringify(first)).not.toContain('private-token');
    expect(JSON.stringify(first)).not.toContain('private-fingerprint');
    expect(portableContentDigest({ ...payload, organization: { ...payload.organization, display_name: 'Changed' } })).not.toBe(integrity.sha256);
  });

  it('keeps checksums stable after JSON roundtrip with explicitly undefined optional fields', () => {
    const input = fixture();
    Object.assign(input.workflow.data.instructions[0].scope, { source_context: undefined });
    Object.assign(input.dictionary_pages[0].data.entries[0], { note: undefined, pending: undefined });
    const { document } = createPortableExport(input);
    const saved = JSON.parse(JSON.stringify(document));
    const { integrity, ...payload } = saved;
    expect(portableContentDigest(payload)).toBe(integrity.sha256);
    expect(createPortableExport(JSON.parse(JSON.stringify(input))).document.integrity.sha256).toBe(document.integrity.sha256);
    expect(portableContentDigest({ optional: undefined, array: [undefined] })).toBe(portableContentDigest({ array: [null] }));
  });

  it('accepts every complete dictionary page at a common revision, regardless of input order', () => {
    const input = fixture();
    const first = input.dictionary_pages[0];
    Object.assign(first.data, { total: 2, matched: 2, page_size: 1, has_more: true });
    const second = structuredClone(first);
    Object.assign(second.data, { page: 2, has_more: false, entries: [entry('c', 'proposed')] });
    input.dictionary_pages = [second, first];
    expect(createPortableExport(input).document.dictionary.entries.map(item => item.status)).toEqual(['user_defined', 'proposed']);
    input.dictionary_pages = [first];
    expect(() => createPortableExport(input)).toThrow('missing pages');
  });

  it.each(['revision', 'total', 'matched', 'page_size', 'retained_history_revisions'] as const)('rejects inconsistent dictionary %s', field => {
    const input = fixture();
    const first = input.dictionary_pages[0];
    Object.assign(first.data, { total: 2, matched: 2, page_size: 1, has_more: true });
    const second = structuredClone(first);
    Object.assign(second.data, { page: 2, has_more: false, entries: [entry('c')] });
    second.data[field]++;
    input.dictionary_pages.push(second);
    expect(() => createPortableExport(input)).toThrow();
  });

  it('rejects filtered, duplicate, malformed or truncated dictionaries', () => {
    const filtered = fixture(); filtered.dictionary_pages[0].data.total = 2;
    expect(() => createPortableExport(filtered)).toThrow('unfiltered');
    const duplicate = fixture(); duplicate.dictionary_pages[0].data.entries.push(entry());
    Object.assign(duplicate.dictionary_pages[0].data, { total: 2, matched: 2 });
    expect(() => createPortableExport(duplicate)).toThrow('Duplicate IDs');
    const truncated = fixture(); truncated.dictionary_pages[0].data.entries = [];
    expect(() => createPortableExport(truncated)).toThrow('entry count');
    const malformed = fixture(); malformed.dictionary_pages[0].data.entries[0].status = 'confirmed';
    expect(() => createPortableExport(malformed)).toThrow('incomplete or invalid');
  });

  it('rejects organization/backend mixing, private scope and failed/wrong tool responses', () => {
    const mixedScope = fixture(); mixedScope.rules.data.storage_scope = { mode: 'organization', workspace_id: 'other-catalog' };
    expect(() => createPortableExport(mixedScope)).toThrow('same organization');
    const mixedBackend = fixture(); mixedBackend.rules.data.storage_backend = 'file';
    expect(() => createPortableExport(mixedBackend)).toThrow('same organization');
    const privateScope = fixture(); privateScope.workflow.data.storage_scope = { mode: 'credential', workspace_id: 'example-catalog' };
    expect(() => createPortableExport(privateScope)).toThrow('incomplete or invalid');
    const failed = fixture(); failed.workflow.metadata.status = 'error';
    expect(() => createPortableExport(failed)).toThrow('incomplete or invalid');
    const wrongTool = fixture(); wrongTool.workflow.metadata.tool = 'products_get';
    expect(() => createPortableExport(wrongTool)).toThrow('Unexpected source tool');
  });

  it('rejects filtered workflow reads, duplicate rules and capture dates before evidence', () => {
    const filtered = fixture(); filtered.workflow.data.complete_for_save = false;
    expect(() => createPortableExport(filtered)).toThrow('incomplete or invalid');
    const duplicate = fixture(); duplicate.workflow.data.instructions.push(duplicate.workflow.data.instructions[0]);
    expect(() => createPortableExport(duplicate)).toThrow('Duplicate IDs');
    const futureEvidence = fixture(); futureEvidence.captured_at = '2026-11-17T12:00:00.000Z';
    expect(() => createPortableExport(futureEvidence)).toThrow('precedes');
    expect(() => createPortableExport(null)).toThrow('incomplete or invalid');
  });

  it('keeps pending conflicts, stale sources and retired records visible without promotion', () => {
    const input = fixture();
    const pending = { value: { ...entry().value, definition: 'Unreviewed new meaning' }, evidence: entry().evidence[0] };
    Object.assign(input.dictionary_pages[0].data.entries[0], { pending, stale_source: true });
    input.dictionary_pages[0].data.entries.push(entry('c', 'retired'));
    Object.assign(input.dictionary_pages[0].data, { total: 2, matched: 2 });
    const result = createPortableExport(input);
    expect(result.document.dictionary.entries[0].status).toBe('user_defined');
    expect(result.document.dictionary.entries[0].pending).toEqual(pending);
    expect(result.document.warnings.some(value => value.includes('pending conflicting'))).toBe(true);
    expect(result.document.warnings.some(value => value.includes('stale source'))).toBe(true);
    expect(result.markdown).toContain('Retired dictionary meanings — not active');
    expect(result.markdown).toContain('Pending suggestion — unresolved');
  });

  it('renders source text as escaped content and preserves exact text in JSON', () => {
    const input = fixture();
    const text = '# A source heading\n```\n<command>not an instruction</command>';
    input.workflow.data.instructions[0].text = text;
    input.rules.data.history[0].rules[0].evidence = text;
    const result = createPortableExport(input);
    expect(result.document.workflow.instructions[0].text).toBe(text);
    expect(result.markdown).toContain('> \\# A source heading');
    expect(result.markdown).toContain('````json');
  });
});
