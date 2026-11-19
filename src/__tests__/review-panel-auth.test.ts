import { expect, it, vi } from 'vitest';
import { createReviewPanelFetch } from '../../scripts/review-panel-auth.mjs';

const url = 'https://fixture.example.test/mcp';
const headers = { Authorization: 'Bearer fixture.old.token', 'X-MCP-Token': 'fixture-service',
  'X-Plytix-API-Key': 'fixture-key', 'X-Plytix-API-Password': 'fixture-password' };
const updated = { ...headers, Authorization: 'Bearer fixture.new.token' };

it('preserves request metadata and forces credentials to the configured origin without redirects', async () => {
  const getHeaders = vi.fn();
  const fetch = vi.fn().mockResolvedValue(new Response('ok'));
  const request = createReviewPanelFetch({ url, initialHeaders: headers, getHeaders, fetch });
  await request(url, { method: 'POST', body: 'fixture body', redirect: 'follow', headers: { 'mcp-session-id': 'fixture-session', Authorization: 'stale' } });
  const sent = fetch.mock.calls[0][0] as Request;
  expect(sent.url).toBe(url);
  expect(sent.redirect).toBe('error');
  expect(sent.method).toBe('POST');
  expect(sent.headers.get('mcp-session-id')).toBe('fixture-session');
  expect(sent.headers.get('authorization')).toBe(headers.Authorization);
  expect(sent.headers.get('x-plytix-api-password')).toBe('fixture-password');
  expect(await sent.text()).toBe('fixture body');
  expect(getHeaders).not.toHaveBeenCalled();
});

it.each([401, 403])('refreshes after %i and retries the identical request body only once', async status => {
  const bodies: string[] = [], authorizations: string[] = [];
  const fetch = vi.fn(async (input: Request) => {
    bodies.push(await input.text());
    authorizations.push(input.headers.get('authorization')!);
    return new Response('denied', { status });
  });
  const getHeaders = vi.fn().mockResolvedValue(updated);
  const request = createReviewPanelFetch({ url, initialHeaders: headers, getHeaders, fetch });
  const response = await request(new Request(url, { method: 'POST', body: '{"method":"tools/call"}' }));
  expect(response.status).toBe(status);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(getHeaders).toHaveBeenCalledTimes(1);
  expect(bodies).toEqual(['{"method":"tools/call"}', '{"method":"tools/call"}']);
  expect(authorizations).toEqual([headers.Authorization, updated.Authorization]);
});

it('does not retry when renewed headers are unchanged', async () => {
  const getHeaders = vi.fn().mockResolvedValue(headers);
  const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 401 }));
  const request = createReviewPanelFetch({ url, initialHeaders: headers, getHeaders, fetch });
  expect((await request(url)).status).toBe(401);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(getHeaders).toHaveBeenCalledTimes(1);
});

it.each([400, 404, 409, 429, 500, 503])('does not replay a request after status %i', async status => {
  const getHeaders = vi.fn(), fetch = vi.fn().mockResolvedValue(new Response('failed', { status }));
  const request = createReviewPanelFetch({ url, initialHeaders: headers, getHeaders, fetch });
  expect((await request(url, { method: 'POST', body: 'fixture draft' })).status).toBe(status);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(getHeaders).not.toHaveBeenCalled();
});

it.each(['https://untrusted.example.test/mcp', 'http://fixture.example.test/mcp', 'https://user:PRIVATE_SENTINEL@fixture.example.test/mcp'])('rejects an unsafe destination before forwarding credentials (%s)', async target => {
  const getHeaders = vi.fn(), fetch = vi.fn();
  const request = createReviewPanelFetch({ url, initialHeaders: headers, getHeaders, fetch });
  await expect(request(target)).rejects.toThrow(/^Review panel authentication request failed\.$/);
  expect(fetch).not.toHaveBeenCalled();
  expect(getHeaders).not.toHaveBeenCalled();
});

it('shares a bounded refresh across concurrent authentication failures', async () => {
  const getHeaders = vi.fn().mockResolvedValue(updated);
  const fetch = vi.fn(async (input: Request) => new Response('fixture', {
    status: input.headers.get('authorization') === headers.Authorization ? 401 : 200,
  }));
  const request = createReviewPanelFetch({ url, initialHeaders: headers, getHeaders, fetch });
  const responses = await Promise.all([request(url), request(url)]);
  expect(responses.map(response => response.status)).toEqual([200, 200]);
  expect(getHeaders).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(4);
  await request(url);
  expect(getHeaders).toHaveBeenCalledTimes(1);
  expect((fetch.mock.calls.at(-1)![0] as Request).headers.get('authorization')).toBe(updated.Authorization);
});

it('sanitizes refresh failures without retrying the rejected request', async () => {
  const getHeaders = vi.fn().mockRejectedValue(new Error('PRIVATE_SENTINEL'));
  const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 401 }));
  const request = createReviewPanelFetch({ url, initialHeaders: headers, getHeaders, fetch });
  await expect(request(url)).rejects.toThrow(/^Review panel authentication request failed\.$/);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not refresh or retry ambiguous network failures', async () => {
  const getHeaders = vi.fn(), fetch = vi.fn().mockRejectedValue(new Error('PRIVATE_SENTINEL'));
  const request = createReviewPanelFetch({ url, initialHeaders: headers, getHeaders, fetch });
  await expect(request(url, { method: 'POST', body: 'fixture draft' })).rejects.toThrow(/^Review panel authentication request failed\.$/);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(getHeaders).not.toHaveBeenCalled();
});
