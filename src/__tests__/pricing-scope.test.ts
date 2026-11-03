import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPricingStore, ScopedPricingStore, type PricingStore } from '../pricing/store.js';
import { pricingScopeStatus, resolvePricingScope } from '../pricing/scope.js';
import { guidanceInstruction, PricingGuidance } from '../pricing/guidance.js';

const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64), d = 'd'.repeat(64);
const bindings = JSON.stringify({ [a]: 'catalog-a', [b]: 'catalog-a', [c]: 'catalog-b' });
const directories: string[] = [];
beforeEach(() => { vi.stubEnv('PLYTIX_PRICING_GCS_BUCKET', ''); vi.stubEnv('PLYTIX_PRICING_SCOPE_BINDINGS', ''); });
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    const child = relative(resolve(tmpdir()), resolve(directory));
    if (!child || child.startsWith('..') || resolve(directory) === resolve(tmpdir())) throw new Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true });
  }
});
async function root() { const directory = await mkdtemp(join(tmpdir(), 'pricing-scope-')); directories.push(directory); return directory; }

describe('explicit pricing organization scope', () => {
  it('keeps the existing credential namespace when organization sharing is not configured', () => {
    expect(resolvePricingScope(a)).toEqual({ mode: 'credential', shared_namespace: a, private_namespace: a });
    const status = pricingScopeStatus(resolvePricingScope(a));
    expect(status).toMatchObject({ mode: 'credential', shared_files: [], drafts_and_audits: 'credential_private' });
    expect(JSON.stringify(status)).not.toContain(a);
  });

  it('binds only exact fingerprints to stable, domain-separated organization namespaces', () => {
    const alice = resolvePricingScope(a, bindings), bob = resolvePricingScope(b, bindings), carol = resolvePricingScope(c, bindings);
    expect(alice.shared_namespace).toBe(bob.shared_namespace);
    expect(alice.shared_namespace).not.toBe(carol.shared_namespace);
    expect(alice.shared_namespace).not.toBe(a);
    expect(alice.private_namespace).toBe(a); expect(bob.private_namespace).toBe(b);
    expect(alice.shared_namespace).toMatch(/^[a-f0-9]{64}$/);
    expect(pricingScopeStatus(alice)).toMatchObject({ mode: 'organization', workspace_id: 'catalog-a' });
    expect(JSON.stringify(pricingScopeStatus(alice))).not.toContain(a);
  });

  it('fails closed for unbound, rotated or malformed credentials without leaking configuration', () => {
    expect(() => resolvePricingScope(d, bindings)).toThrow('not bound');
    expect(() => resolvePricingScope(a, '{}')).toThrow('not bound');
    expect(() => resolvePricingScope('user@example.test', bindings)).toThrow('Invalid pricing credential scope');
    for (const value of ['not-json', '[]', 'null', JSON.stringify({ wrong: 'catalog-a' }), JSON.stringify({ [a]: '' }), JSON.stringify({ [a]: 'x'.repeat(161) }), JSON.stringify({ [a]: 'catalog\nother' })]) {
      expect(() => resolvePricingScope(a, value)).toThrow('bindings are invalid');
    }
    expect(() => resolvePricingScope(a, JSON.stringify({ [a]: 'private-value'.repeat(10000) }))).toThrow('bindings are invalid');
  });

  it('shares only rules, dictionary and workflow files while retaining private source/run identities', async () => {
    const directory = await root(); vi.stubEnv('PLYTIX_PRICING_SCOPE_BINDINGS', bindings);
    const alice = createPricingStore(a, directory), bob = createPricingStore(b, directory), carol = createPricingStore(c, directory);
    for (const key of ['rules.json', 'rules-revision-1.json', 'dictionary.json', 'workflow.json']) {
      await alice.create(key, { record: key, revision: 1 });
      expect(await bob.read(key)).toEqual({ record: key, revision: 1 });
      expect(await carol.read(key)).toBeUndefined();
    }
    const id = `${randomUUID()}.json`;
    await alice.create(id, { source: 'Alice private source', state: 'executing' });
    expect(await bob.read(id)).toBeUndefined();
    await bob.create(id, { source: 'Bob independent source', state: 'draft' });
    expect(await alice.read(id)).toEqual({ source: 'Alice private source', state: 'executing' });
    expect(await bob.read(id)).toEqual({ source: 'Bob independent source', state: 'draft' });
    expect(JSON.parse(await readFile(join(directory, a, id), 'utf8')).state).toBe('executing');
    expect(alice.scope).toMatchObject({ mode: 'organization', workspace_id: 'catalog-a', drafts_and_audits: 'credential_private' });
  });

  it('uses the same atomic revision guards for shared edits through independent credentials', async () => {
    const directory = await root(); vi.stubEnv('PLYTIX_PRICING_SCOPE_BINDINGS', bindings);
    const alice = createPricingStore(a, directory), bob = createPricingStore(b, directory);
    await alice.create('workflow.json', { revision: 0, values: [] });
    const append = (store: PricingStore, value: string) => store.update('workflow.json', raw => raw as { revision: number; values: string[] }, previous => {
      if (previous.revision !== 0) throw new Error('Changed revision');
      return { revision: 1, values: [value] };
    });
    const results = await Promise.allSettled([append(alice, 'A'), append(bob, 'B')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await alice.read('workflow.json') as any).values).toHaveLength(1);
  });

  it('does not migrate legacy guidance or reset private execution reservations on binding', async () => {
    const directory = await root(), previous = createPricingStore(a, directory), key = `${randomUUID()}.json`;
    await previous.create('rules.json', { legacy_rules: true });
    await previous.create(key, { state: 'executing' });
    vi.stubEnv('PLYTIX_PRICING_SCOPE_BINDINGS', bindings);
    const shared = createPricingStore(a, directory);
    expect(await shared.read('rules.json')).toBeUndefined();
    expect(await shared.read(key)).toEqual({ state: 'executing' });
    expect(JSON.parse(await readFile(join(directory, a, 'rules.json'), 'utf8'))).toEqual({ legacy_rules: true });
    expect(() => createPricingStore(d, directory)).toThrow('not bound');
  });

  it('keeps protected guidance stable across an explicit credential rotation without sharing old private runs', async () => {
    const directory = await root(); vi.stubEnv('PLYTIX_PRICING_SCOPE_BINDINGS', bindings);
    const alice = createPricingStore(a, directory), privateRun = `${randomUUID()}.json`;
    const instruction = guidanceInstruction.parse({ id: 'preserve_custom_price', title: 'Preserve custom pricing',
      text: 'A custom supplier agreement must not be replaced by a standard list price.', priority: 'required', status: 'active', source_ref: 'Explicit owner requirement' });
    await new PricingGuidance(alice).save({ expected_revision: 0, instructions: [instruction], exclusions: [] });
    await alice.create(privateRun, { state: 'executing' });
    expect((await new PricingGuidance(createPricingStore(b, directory)).get()).instructions).toEqual([instruction]);
    expect((await new PricingGuidance(createPricingStore(c, directory)).get()).instructions).toEqual([]);
    // Rotation is an operator-approved configuration edit, not inferred membership.
    vi.stubEnv('PLYTIX_PRICING_SCOPE_BINDINGS', JSON.stringify({ [d]: 'catalog-a', [b]: 'catalog-a', [c]: 'catalog-b' }));
    const replacement = createPricingStore(d, directory);
    expect((await new PricingGuidance(replacement).get()).instructions).toEqual([instruction]);
    expect(await replacement.read(privateRun)).toBeUndefined();
    expect(() => createPricingStore(a, directory)).toThrow('not bound');
    expect(JSON.parse(await readFile(join(directory, a, privateRun), 'utf8')).state).toBe('executing');
  });

  it('does not imply synchronization between different storage roots', async () => {
    vi.stubEnv('PLYTIX_PRICING_SCOPE_BINDINGS', bindings);
    const one = createPricingStore(a, await root()), two = createPricingStore(a, await root());
    await one.create('dictionary.json', { retained: true });
    expect(await two.read('dictionary.json')).toBeUndefined();
    expect(one.scope?.guidance).toContain('same storage backend');
  });

  it('routes cloud operations through the same guarded key classification and rejects unknown keys', async () => {
    const shared = { kind: 'gcs', read: vi.fn(async () => 'shared'), create: vi.fn(async () => {}), update: vi.fn() } as unknown as PricingStore;
    const personal = { kind: 'gcs', read: vi.fn(async () => 'private'), create: vi.fn(async () => {}), update: vi.fn() } as unknown as PricingStore;
    const store = new ScopedPricingStore(shared, personal, pricingScopeStatus(resolvePricingScope(a, bindings)));
    expect(await store.read('workflow.json')).toBe('shared');
    expect(await store.read(`${randomUUID()}.json`)).toBe('private');
    expect(() => store.read('../workflow.json')).toThrow('storage key');
    expect(() => store.read('members.json')).toThrow('storage key');
    expect(() => store.read('workflow-revision-1.json')).toThrow('storage key');
    expect(shared.read).toHaveBeenCalledTimes(1); expect(personal.read).toHaveBeenCalledTimes(1);
  });
});
