import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import { READ_TOOLS, WRITE_TOOLS } from '../policy.js';
import type { PlytixClient } from '../client.js';

export interface ToolDefinition {
  title?: string;
  description: string;
  inputSchema: ZodRawShape;
}
const policies = new WeakMap<McpServer, ReadonlySet<string>>();
const clients = new WeakMap<McpServer, PlytixClient>();
export function configureToolPolicy(server: McpServer, writes: ReadonlySet<string>, client: PlytixClient) {
  for (const name of writes) if (!WRITE_TOOLS.has(name)) throw new Error('Unknown write tool');
  policies.set(server, new Set(writes));
  clients.set(server, client);
}

export function registerTool<TArgs extends Record<string, unknown>>(
  server: McpServer, name: string, definition: ToolDefinition,
  handler: (args: TArgs) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>,
): void {
  const readOnly = READ_TOOLS.has(name);
  if (!readOnly && !WRITE_TOOLS.has(name)) throw new Error(`Unclassified tool: ${name}`);
  if (!readOnly && !policies.get(server)?.has(name)) return;
  // Erase SDK/Zod recursive inference only at this boundary. SDK validates inputs.
  (server.registerTool as any)(name, {
    ...definition,
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true },
  }, async (args: TArgs, extra: { signal: AbortSignal }) => {
    try { return await clients.get(server)!.runOperation(() => handler(args), extra.signal); }
    catch { return { content: [{ type: 'text', text: 'Tool execution failed' }], isError: true }; }
  });
}
