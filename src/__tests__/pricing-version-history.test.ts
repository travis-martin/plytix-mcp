import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FilePricingStore, GcsPricingStore, PricingStoreConflict, type PricingObjectBackend, type VersionedObject } from '../pricing/store.js';
import { archiveKey, getVersionHistory, validateRevisionArchive } from '../pricing/version-history.js';
import { guidanceDocument, PricingGuidance } from '../pricing/guidance.js';
import { prepareHistoryRollback } from '../pricing/history-rollback.js';
import { createPortableExport } from '../pricing/portable-export.js';
import { prepareReviewedImport } from '../pricing/reviewed-import.js';
import { decorateResult } from '../results.js';

const prefix = 'a'.repeat(64), at = '2026-11-18T12:00:00.000Z';
const review = { change_id: 'change-fixture-20261118', reason: 'Fixture owner correction', sources: [{ kind: 'user' as const, reference: 'Fixture owner decision' }] };
const empty = () => guidanceDocument.parse({ version: 1, revision: 0, updated_at: '', instructions: [], exclusions: [] });
const instruction = (id: string, text = id) => ({ id, title: id, text, scope: { family_ids: [] }, priority: 'required' as const, status: 'active' as const, source_ref: 'Fixture owner decision' });
class Objects implements PricingObjectBackend {
  values = new Map<string, VersionedObject>(); version = 0;
  async read(key: string) { await Promise.resolve(); const value = this.values.get(key); return value ? { generation: value.generation, bytes: Buffer.from(value.bytes) } : undefined; }
  async write(key: string, bytes: Buffer, expected: string | 0) {
    await Promise.resolve();
    if ((this.values.get(key)?.generation ?? 0) !== expected) throw new PricingStoreConflict();
    this.values.set(key, { generation: String(++this.version), bytes: Buffer.from(bytes) });
  }
}
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir()) + '/') && !resolve(path).startsWith(resolve(tmpdir()) + '\\')) throw new Error('Unexpected fixture path');
    await rm(path, { force: true, recursive: true });
  }
});
async function local() { const path = await mkdtemp(join(tmpdir(), 'pricing-history-')); directories.push(path); return { path, store: new FilePricingStore(path) }; }
const parse = (raw: unknown) => guidanceDocument.parse(raw ?? empty());

describe('retained pricing version history', () => {
  it('retains a complete legacy baseline and more revisions than bounded working history, with read-only pagination', async () => {
    const { store, path } = await local();
    await writeFile(join(path, 'workflow.json'), JSON.stringify(empty()));
    expect((await getVersionHistory(store, { document: 'workflow' })).state).toBe('legacy_unarchived');
    const guidance = new PricingGuidance(store);
    for (let revision = 0; revision < 27; revision++) await guidance.save({ expected_revision: revision, instructions: [], exclusions: [], review });
    expect(parse(await store.read('workflow.json')).history).toHaveLength(20);
    const files = await readdir(path), first = await getVersionHistory(store, { document: 'workflow', limit: 25 });
    expect(first.revisions.map(item => item.revision)).toEqual(Array.from({ length: 25 }, (_, i) => 27 - i));
    const second = await getVersionHistory(store, { document: 'workflow', cursor: first.next_cursor!, limit: 25 });
    expect(second.revisions.map(item => item.revision)).toEqual([2, 1, 0]); expect(second.complete).toBe(true);
    expect(second.revisions.at(-1)?.operation).toBe('baseline');
    expect(first.revisions[0]).toMatchObject({ operation: 'user_save', review });
    expect(first.revisions[0]).not.toHaveProperty('snapshot');
    expect(await readdir(path)).toEqual(files);
    expect(files.filter(name => name.startsWith('history-'))).toHaveLength(28);
    const unchanged = await store.update('workflow.json', parse, doc => doc);
    expect(unchanged.revision).toBe(27); expect(await readdir(path)).toEqual(files);
  });

  it('archives before current commit and keeps failed CAS candidates out of committed history', async () => {
    const backend = new Objects(), store = new GcsPricingStore(backend, prefix);
    await store.create('workflow.json', empty());
    const current = await store.read('workflow.json');
    const original = backend.write.bind(backend);
    vi.spyOn(backend, 'write').mockImplementation(async (key, bytes, expected) => {
      if (key.endsWith('/workflow.json')) throw new Error('Fixture current write failure');
      return original(key, bytes, expected);
    });
    await expect(new PricingGuidance(store).save({ expected_revision: 0, instructions: [], exclusions: [], review })).rejects.toThrow('current write failure');
    expect(await store.read('workflow.json')).toEqual(current);
    const history = await getVersionHistory(store, { document: 'workflow' });
    expect(history.revisions.map(item => item.revision)).toEqual([0]);
    const orphan = [...backend.values.keys()].filter(key => key.includes('/history-')).map(key => JSON.parse(backend.values.get(key)!.bytes.toString()))
      .find(item => item.revision === 1);
    expect(orphan).toBeDefined();
    await expect(getVersionHistory(store, { document: 'workflow', cursor: orphan.change_id })).rejects.toThrow('not reachable');
  });

  it('fails closed before current changes if archival storage fails, and detects tampered archives', async () => {
    const backend = new Objects(), store = new GcsPricingStore(backend, prefix);
    await store.create('workflow.json', empty());
    const original = backend.write.bind(backend), before = await store.read('workflow.json');
    const spy = vi.spyOn(backend, 'write').mockImplementation(async (key, bytes, expected) => {
      if (key.includes('/history-')) throw new Error('Fixture archive failure');
      return original(key, bytes, expected);
    });
    await expect(new PricingGuidance(store).save({ expected_revision: 0, instructions: [], exclusions: [], review })).rejects.toThrow('archive failure');
    expect(await store.read('workflow.json')).toEqual(before); spy.mockRestore();
    const head = parse(before).version_history!, key = `pricing/${prefix}/${archiveKey('workflow', head.head_id)}`;
    const corrupt = JSON.parse(backend.values.get(key)!.bytes.toString()); corrupt.snapshot.updated_at = at;
    backend.values.set(key, { generation: '999', bytes: Buffer.from(JSON.stringify(corrupt)) });
    await expect(getVersionHistory(store, { document: 'workflow' })).rejects.toThrow('integrity');
    await expect(new PricingGuidance(store).save({ expected_revision: 0, instructions: [], exclusions: [], review })).rejects.toThrow('integrity');
    expect(await store.read('workflow.json')).toEqual(before);
  });

  it('handles a concurrent reviewed save without losing or falsely committing the rejected revision', async () => {
    const backend = new Objects(), store = new GcsPricingStore(backend, prefix);
    await store.create('workflow.json', empty());
    const save = (id: string) => new PricingGuidance(new GcsPricingStore(backend, prefix)).save({ expected_revision: 0,
      instructions: [instruction(id)], exclusions: [], review });
    const results = await Promise.allSettled([save('first'), save('second')]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    const history = await getVersionHistory(store, { document: 'workflow' });
    expect(history.revisions.map(item => item.revision)).toEqual([1, 0]);
    const head = history.revisions[0];
    await expect(store.update(archiveKey('workflow', head.change_id), raw => raw, raw => raw)).rejects.toThrow('immutable');
    const write = vi.spyOn(backend, 'write');
    await store.update('workflow.json', parse, doc => doc); expect(write).not.toHaveBeenCalled();
  });

  it('validates a complete snapshot and prepares forward rollback through reviewed save APIs', async () => {
    const backend = new Objects(), store = new GcsPricingStore(backend, prefix), guidance = new PricingGuidance(store);
    await store.create('workflow.json', empty());
    await guidance.save({ expected_revision: 0, instructions: [instruction('older')], exclusions: [], review });
    await guidance.save({ expected_revision: 1, instructions: [instruction('older', 'changed'), instruction('newer')], exclusions: [], review });
    const list = await getVersionHistory(store, { document: 'workflow' });
    const oldId = list.revisions[1].change_id;
    const history = await getVersionHistory(store, { document: 'workflow', cursor: oldId, limit: 1, include_snapshots: true });
    validateRevisionArchive(history.revisions[0]);
    const scope = { storage_scope: { mode: 'organization', workspace_id: 'fixture' }, storage_backend: 'gcs' };
    const wrap = (tool: string, data: unknown) => ({ data: { ...data as object, ...scope }, metadata: { tool, status: 'ok', generated_at: at } });
    const capture = { organization: 'Fixture', captured_at: at, workflow: wrap('pricing_guidance_get', await guidance.get({ include_retired: true })),
      dictionary_pages: [wrap('pricing_dictionary_get', { revision: 0, updated_at: '', entries: [], total: 0, matched: 0, page: 1, page_size: 100, has_more: false, retained_history_revisions: 0 })],
      rules: wrap('pricing_rules_get', { revision: 0, updated_at: '', rules: [], history: [] }) };
    const current = createPortableExport(capture).document;
    const envelope = decorateResult('pricing_history_get', { content: [{ type: 'text', text: JSON.stringify({ ...history, ...scope }) }] }, at, []).structuredContent;
    expect(envelope.metadata.status).toBe('partial');
    const input = { current, history: envelope, change_id: oldId, review };
    const prepared = prepareHistoryRollback(input);
    expect(prepared.candidate.workflow?.instructions).toMatchObject([{ id: 'older', text: 'older' }, { id: 'newer', status: 'retired' }]);
    expect(prepared.candidate).not.toHaveProperty('version_history');
    expect(prepared.candidate.decisions.confirm_rule_ids).toEqual([]);
    const proposal = prepareReviewedImport({ baseline: current, candidate: prepared.candidate, capture });
    expect(proposal.calls[0]).toMatchObject({ tool: 'pricing_guidance_save', arguments: { expected_revision: 2, review } });
    expect(() => prepareHistoryRollback({ ...input, change_id: 'b'.repeat(64) })).toThrow('integrity');
    const stale = structuredClone(input); (stale.history.data as { current_revision: number }).current_revision++;
    expect(() => prepareHistoryRollback(stale)).toThrow('revisions differ');
    expect(parse(await store.read('workflow.json')).revision).toBe(2);
  });
});
