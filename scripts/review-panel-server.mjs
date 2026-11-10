import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

// A loopback host for the same MCP App when a chat does not expose native MCP
// app tools. Only this review's draft decisions and readback are reachable.
export const PANEL_TOOLS = new Set(['pricing_review_get', 'pricing_review_refresh', 'pricing_review_update', 'pricing_review_plan']);
export async function startReviewPanel({ reviewId, callTool, workspaceHtml, hostScript, port = 0 }) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(reviewId)) throw new Error('A saved review UUID is required');
  const token = randomBytes(32).toString('hex');
  let origin, queue = Promise.resolve();
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    const reply = (status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (req.headers.host !== new URL(origin).host || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return reply(403, { error: 'Local panel origin required' });
    if (req.method === 'GET') {
      if (req.url === '/') return reply(200, '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plytix price review</title></head><body style="margin:0;font:13px system-ui;color:#222;background:#fff"><p id="panel-status" role="status" style="margin:0;padding:10px 14px;border-bottom:1px solid #ddd">Edits save to this review. Posting prices requires approval in chat.</p><iframe id="workspace" title="Editable price review" style="display:block;width:100%;height:calc(100dvh - 42px);border:0"></iframe><script src="/config.js"></script><script type="module" src="/host.js"></script></body></html>', 'text/html; charset=utf-8');
      if (req.url === '/config.js') return reply(200, `window.reviewPanelConfig=${JSON.stringify({ reviewId, token })};`, 'text/javascript');
      if (req.url === '/host.js') return reply(200, hostScript, 'text/javascript');
      if (req.url === '/workspace') return reply(200, workspaceHtml, 'text/html; charset=utf-8');
      return reply(404, { error: 'Not found' });
    }
    if (req.method !== 'POST' || req.url !== '/tool') return reply(405, { error: 'Method not allowed' });
    if (req.headers.origin !== origin || req.headers['x-review-panel-token'] !== token || req.headers['content-type'] !== 'application/json') return reply(403, { error: 'Same-origin panel request required' });
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1_000_000) return reply(413, { error: 'Request too large' }); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input || !PANEL_TOOLS.has(input.name) || !input.arguments || input.arguments.review_id !== reviewId) return reply(403, { error: 'Only this review can be read or revised. Product writes are unavailable in this panel.' });
      // The remote MCP session allows one active tool at a time. Queue drafts;
      // never retry one whose outcome may already have been saved remotely.
      const result = queue.then(() => callTool({ name: input.name, arguments: input.arguments }));
      queue = result.then(() => undefined, () => undefined);
      return reply(200, await result);
    } catch { return reply(502, { error: 'The review request failed. Refresh its saved state before trying again.' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: origin, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
