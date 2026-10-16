import { createHash, timingSafeEqual } from 'node:crypto';
import type { ErrorRequestHandler } from 'express';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PlytixClient } from './client.js';
import { createServer } from './server.js';
import { parseWriteTools } from './policy.js';

export interface HttpConfig {
  host: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  authToken?: string;
  writeTools: ReadonlySet<string>;
  requestsPerMinute?: number;
  maxConcurrentRequests?: number;
}
export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const host = env.HOST ?? (env.K_SERVICE ? '0.0.0.0' : '127.0.0.1');
  return {
    host,
    allowedHosts: (env.MCP_ALLOWED_HOSTS ?? 'localhost,127.0.0.1,[::1]').split(',').filter(Boolean),
    allowedOrigins: (env.MCP_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
    authToken: env.MCP_AUTH_TOKEN,
    writeTools: parseWriteTools(env.PLYTIX_WRITE_TOOLS),
  };
}
const digest = (value: string) => createHash('sha256').update(value).digest();

export function createHttpApp(config: HttpConfig) {
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(config.host);
  if ((!loopback || config.writeTools.size > 0) && (!config.authToken || config.authToken.length < 32)) {
    throw new Error('Remote access or write tools require MCP_AUTH_TOKEN of at least 32 characters');
  }
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  let count = 0, windowStart = Date.now(), active = 0;
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const host = req.headers.host;
    // Match an exact hostname, with an optional numeric port. Ignore forwarded headers.
    const hostname = host?.replace(/:\d+$/, '');
    if (!hostname || !config.allowedHosts.includes(hostname)) { res.sendStatus(403); return; }
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) { res.sendStatus(403); return; }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, MCP-Protocol-Version, X-MCP-Token, X-Plytix-API-Key, X-Plytix-API-Password');
    }
    if (req.path === '/health' && req.method === 'GET') { res.json({ status: 'ok' }); return; }
    if (req.path !== '/mcp') { res.sendStatus(404); return; }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    // Authorization is deliberately left for Cloud Run's OIDC/IAM edge authentication.
    if (config.authToken && !timingSafeEqual(digest(req.get('x-mcp-token') ?? ''), digest(config.authToken))) {
      res.sendStatus(401); return;
    }
    if (req.headers['mcp-session-id']) { res.status(400).json({ error: 'Sessions are not supported' }); return; }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); res.sendStatus(405); return; }
    if (Date.now() - windowStart >= 60_000) { count = 0; windowStart = Date.now(); }
    if (++count > (config.requestsPerMinute ?? 60) || active >= (config.maxConcurrentRequests ?? 4)) {
      res.setHeader('Retry-After', '60'); res.sendStatus(429); return;
    }
    active++;
    res.once('close', () => {
      const client = res.locals.plytixClient as PlytixClient | undefined;
      client?.cancel();
      // Disconnects must not free capacity while an underlying handler is still running.
      void (client?.waitForIdle() ?? Promise.resolve()).finally(() => { active--; });
    });
    next();
  });
  app.use(express.json({ limit: '256kb', strict: true }));
  app.post('/mcp', async (req, res) => {
    if (Array.isArray(req.body)) { res.status(400).json({ error: 'Batch requests are not supported' }); return; }
    const apiKey = req.get('x-plytix-api-key') ?? '';
    const apiPassword = req.get('x-plytix-api-password') ?? '';
    if (!apiKey || !apiPassword || apiKey.length > 4096 || apiPassword.length > 4096) {
      res.status(401).json({ error: 'Plytix credential headers are required' }); return;
    }
    // Each HTTP request owns its client, token and metadata caches. No cross-credential reuse.
    const client = new PlytixClient({ apiKey, apiPassword, allowWrites: config.writeTools.size > 0 });
    res.locals.plytixClient = client;
    const server = createServer(client, config.writeTools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
    }
  });
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error?.type === 'entity.too.large' ? 413 : 400;
    if (!res.headersSent) res.status(status).json({ error: 'Invalid request body' });
  };
  app.use(errorHandler);
  return app;
}
