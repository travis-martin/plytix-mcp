import { afterEach, expect, it, vi } from 'vitest';
import { get } from 'node:http';
import { startReviewPanel, PANEL_TOOLS } from '../../scripts/review-panel-server.mjs';

const reviewId = '33333333-3333-4333-8333-333333333333';
let panel: Awaited<ReturnType<typeof startReviewPanel>>;
afterEach(async () => { if (panel) await panel.close(); });
async function fixture() {
  const callTool = vi.fn(async () => ({ content: [], structuredContent: { data: { review_id: reviewId } } }));
  panel = await startReviewPanel({ reviewId, callTool, workspaceHtml: '<p>Shared workspace</p>', hostScript: '/* host */' });
  const config = await (await fetch(`${panel.url}/config.js`)).text();
  const { token } = JSON.parse(config.replace(/^window.reviewPanelConfig=/, '').replace(/;$/, ''));
  const post = (name: string, args = { review_id: reviewId }, headers = {}) => fetch(`${panel.url}/tool`, {
    method: 'POST', headers: { Origin: panel.url, 'Content-Type': 'application/json', 'X-Review-Panel-Token': token, ...headers }, body: JSON.stringify({ name, arguments: args }),
  });
  return { callTool, post };
}

it('serves the shared app and saves only scoped review drafts', async () => {
  const { post, callTool } = await fixture();
  expect((await fetch(`${panel.url}/workspace`)).headers.get('cache-control')).toBe('no-store');
  for (const name of PANEL_TOOLS) expect((await post(name)).status).toBe(200);
  expect(callTool).toHaveBeenCalledTimes(4);
});

it('denies writes, other reviews, foreign origins, missing tokens and DNS rebinding', async () => {
  const { post, callTool } = await fixture();
  for (const name of ['pricing_review_apply', 'products_set_attribute', 'pricing_apply', 'pricing_rules_save', 'pricing_guidance_save']) expect((await post(name)).status).toBe(403);
  expect((await post('pricing_review_get', { review_id: 'another-review' })).status).toBe(403);
  expect((await post('pricing_review_get', undefined, { Origin: 'https://untrusted.example' })).status).toBe(403);
  expect((await post('pricing_review_get', undefined, { 'X-Review-Panel-Token': '' })).status).toBe(403);
  expect((await fetch(`${panel.url}/config.js`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
  const rebound = await new Promise(resolve => get(`${panel.url}/`, { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); }));
  expect(rebound).toBe(403);
  expect(callTool).not.toHaveBeenCalled();
});

it('serializes session operations without retrying a failed draft or leaking raw errors', async () => {
  const { post, callTool } = await fixture();
  let active = 0, maximum = 0;
  callTool.mockImplementation(async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    throw new Error('private authentication details');
  });
  const responses = await Promise.all([post('pricing_review_update'), post('pricing_review_plan')]);
  expect(maximum).toBe(1); expect(callTool).toHaveBeenCalledTimes(2);
  for (const response of responses) { expect(response.status).toBe(502); expect(await response.text()).not.toContain('private authentication'); }
});
