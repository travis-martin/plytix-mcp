import { afterEach, expect, it, vi } from 'vitest';
import { decorateResult } from '../results.js';
import { PlytixClient } from '../client.js';

afterEach(() => vi.restoreAllMocks());
const json = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

it('distinguishes response generation from cached evidence and preserves the legacy data', () => {
  const result = json([{ id: 'p' }]);
  const decorated = decorateResult('products_get', result, '2026-10-20T12:00:00.000Z', [
    { source: '/fixture', observed_at: '2026-10-19T12:00:00.000Z' },
  ]);
  expect(decorated.content[0]).toEqual(result.content[0]);
  expect(decorated.structuredContent.data).toEqual([{ id: 'p' }]);
  expect(decorated.structuredContent.metadata).toMatchObject({ freshness: 'cached', coverage: 'not_asserted' });
});

it('does not mistake a completed tool, sampled query or accepted write for full coverage', () => {
  expect(decorateResult('attributes_profile_usage', json({ scope: { complete_for_query: false } }), '', [])
    .structuredContent.metadata).toMatchObject({ status: 'partial', coverage: 'partial' });
  expect(decorateResult('relationships_link_product', json({ accepted: true, verification: 'unavailable' }), '', [])
    .structuredContent.metadata.coverage).toBe('not_asserted');
  expect(decorateResult('attributes_profile_usage', json({ scope: { complete_for_query: true } }), '', [])
    .structuredContent.metadata.coverage).toBe('complete_for_query');
});

it('offers a retry hint only for rate-limited reads, never for a mutation', () => {
  const error = { content: [{ type: 'text', text: 'Plytix request failed (HTTP 429)' }], isError: true };
  expect(decorateResult('products_get', error, '', []).structuredContent.metadata.retryable).toBe(true);
  expect(decorateResult('products_update', error, '', []).structuredContent.metadata.retryable).toBe(false);
});

it('keeps real cached attribute evidence dated and prevents consumers mutating the cache', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    const path = String(url);
    if (path.includes('/auth/')) return Response.json({ data: [{ access_token: 'fixture' }] });
    return Response.json({ data: [{ id: 'a', label: 'thickness', name: 'Thickness', type_class: 'NumberAttribute' }] });
  });
  const api = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture' });
  const first = await api.runOperation(() => api.getAttributeByLabel('thickness'));
  first!.name = 'Consumer changed';
  const second = await api.runOperation(() => api.getAttributeByLabel('thickness'));
  expect(second!.name).toBe('Thickness');
  expect(api.getReadEvidence()).toEqual([{ source: '/api/v1/attributes/product/a', observed_at: expect.any(String), cached: true }]);
});
