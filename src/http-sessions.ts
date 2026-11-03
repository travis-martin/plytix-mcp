import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import type { Express } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { PlytixClient } from './client.js';
import { createServer } from './server.js';
import { elicitWriteApproval } from './tools/register.js';
import type { HttpConfig } from './http.js';

/** Private trusted MCP hosts only, like stdio. This is not public OAuth.
 * Credentials and service authentication are required on every protocol message.
 * A lost session cancels pending approvals; persisted pricing plans prevent replay.
 */
export function registerApprovalSessions(app: Express, config: HttpConfig) {
  const sessions = new Map<string, {
    identity: Buffer; client: PlytixClient; server: ReturnType<typeof createServer>;
    transport: StreamableHTTPServerTransport; timer: NodeJS.Timeout;
  }>();
  const draining = new Map<string, Promise<void>>();
  let shuttingDown = false;
  const maximum = config.maxConcurrentRequests ?? 4;
  async function close(id: string) {
    const session = sessions.get(id);
    if (!session) { await draining.get(id); return; }
    sessions.delete(id); clearTimeout(session.timer); session.client.cancel();
    // Keep capacity reserved until the cancelled handler actually finishes.
    // Deferred entry avoids reentrancy from the transport's onclose callback.
    const pending = Promise.resolve().then(async () => {
      try { await session.server.close(); }
      finally { await session.client.waitForIdle(); }
    }).finally(() => { draining.delete(id); });
    draining.set(id, pending);
    await pending;
  }
  app.locals.closeApprovalSessions = async () => {
    shuttingDown = true;
    await Promise.allSettled([...sessions.keys()].map(close));
    await Promise.allSettled([...draining.values()]);
  };
  app.all('/mcp', async (req, res) => {
    if (shuttingDown) { res.sendStatus(503); return; }
    const key = req.get('x-plytix-api-key') ?? '', password = req.get('x-plytix-api-password') ?? '';
    if (!key || !password || key.length > 4096 || password.length > 4096) { res.sendStatus(401); return; }
    if (Array.isArray(req.body)) { res.sendStatus(400); return; }
    const identity = createHash('sha256').update(JSON.stringify([key, password])).digest();
    let id = req.get('mcp-session-id');
    try {
      if (!id) {
        if (req.method !== 'POST' || !isInitializeRequest(req.body)) { res.status(400).json({ error: 'Initialize a new authenticated session' }); return; }
        if (sessions.size + draining.size >= maximum) { res.setHeader('Retry-After', '60'); res.sendStatus(429); return; }
        id = randomUUID();
        const client = new PlytixClient({ apiKey: key, apiPassword: password, allowWrites: config.writeTools.size > 0, writeTools: config.writeTools });
        const server = createServer(client, config.writeTools, {
          knowledgeRegistry: config.knowledgeRegistry, knowledgeWriteTools: config.knowledgeWriteTools,
          requestWriteApproval: elicitWriteApproval,
        });
        const sessionId = id;
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
        const timer = setTimeout(() => { void close(sessionId).catch(() => {}); }, 10 * 60_000); timer.unref();
        sessions.set(id, { identity, client, server, transport, timer });
        transport.onclose = () => { void close(sessionId).catch(() => {}); };
        await server.connect(transport);
      }
      const session = sessions.get(id);
      if (!session || !timingSafeEqual(identity, session.identity)) { res.sendStatus(404); return; }
      const sessionId = id;
      // A disconnected call can no longer receive a form or reliable result.
      if (req.method === 'POST' && req.body?.method === 'tools/call') {
        res.once('close', () => { if (!res.writableEnded) void close(sessionId).catch(() => {}); });
      }
      await session.transport.handleRequest(req, res, req.body);
      if (req.method === 'DELETE') await close(sessionId);
    } catch {
      if (id) await close(id).catch(() => {});
      if (!res.headersSent) res.status(500).json({ error: 'MCP session failed; reconnect and review any pending plan' });
    }
  });
}
