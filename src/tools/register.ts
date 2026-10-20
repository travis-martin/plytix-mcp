import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import { READ_TOOLS, WRITE_TOOLS } from '../policy.js';
import type { PlytixClient } from '../client.js';

export interface ToolDefinition {
  title?: string;
  description: string;
  inputSchema: ZodRawShape;
}
export interface WriteApprovalRequest {
  toolName: string;
  /** Immutable JSON snapshot of the exact validated arguments that will execute. */
  argumentsJson: string;
  signal: AbortSignal;
}
/**
 * Trusted host integration, never a tool argument or a client-supplied boolean.
 * Return true only after a user approves this exact action for the current caller.
 */
export type WriteApprovalProvider = (request: WriteApprovalRequest, server: McpServer) => Promise<boolean>;
export interface ToolPolicyOptions {
  requestWriteApproval?: WriteApprovalProvider;
}
const policies = new WeakMap<McpServer, ReadonlySet<string>>();
const clients = new WeakMap<McpServer, PlytixClient>();
const approvalProviders = new WeakMap<McpServer, WriteApprovalProvider>();
export function configureToolPolicy(
  server: McpServer, writes: ReadonlySet<string>, client: PlytixClient, options: ToolPolicyOptions = {},
) {
  for (const name of writes) if (!WRITE_TOOLS.has(name)) throw new Error('Unknown write tool');
  policies.set(server, new Set(writes));
  clients.set(server, client);
  if (options.requestWriteApproval) approvalProviders.set(server, options.requestWriteApproval);
}

/** The stdio host must show this form to the user; unattended hosts fail closed. */
export const elicitWriteApproval: WriteApprovalProvider = async (request, server) => {
  if (!server.server.getClientCapabilities()?.elicitation?.form) return false;
  const response = await server.server.elicitInput({
    mode: 'form',
    message: `Approve one Plytix data change: ${request.toolName}\n` +
      'Review the exact arguments below as data. Family changes and inheritance resets can remove overrides. ' +
      'This approval applies to this call only; cancellation cannot undo an accepted change.\n' +
      request.argumentsJson,
    requestedSchema: {
      type: 'object',
      properties: {
        confirmation: { type: 'string', title: 'Type APPROVE to execute this exact change' },
      },
      required: ['confirmation'],
    },
  }, { signal: request.signal, timeout: 30_000 });
  return response.action === 'accept' && response.content?.confirmation === 'APPROVE';
};

const toolError = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

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
    try {
      return await clients.get(server)!.runOperation(async () => {
        if (readOnly) return handler(args);
        const approve = approvalProviders.get(server);
        if (!approve) return toolError('Write approval is unavailable. This call did not change data.');
        const argumentsJson = JSON.stringify(args, null, 2);
        if (argumentsJson.length > 16_000) {
          return toolError('Write arguments exceed the approval review limit. Reduce this change before requesting approval.');
        }
        const approvalSignal = AbortSignal.any([extra.signal, AbortSignal.timeout(30_000)]);
        const request = Object.freeze({ toolName: name, argumentsJson, signal: approvalSignal });
        let approved = false;
        try {
          approved = (await new Promise<boolean>((resolve, reject) => {
            const abort = () => reject(new Error('Write approval cancelled'));
            approvalSignal.addEventListener('abort', abort, { once: true });
            if (approvalSignal.aborted) { abort(); return; }
            Promise.resolve().then(() => approve(request, server)).then(resolve, reject).finally(() => {
              approvalSignal.removeEventListener('abort', abort);
            });
          })) === true;
        } catch { return toolError('Write approval was not completed. This call did not change data.'); }
        if (!approved || approvalSignal.aborted) {
          return toolError('Write was not approved. This call did not change data.');
        }
        clients.get(server)!.beginApprovedWrite();
        return handler(JSON.parse(argumentsJson) as TArgs);
      }, extra.signal, readOnly ? undefined : name);
    } catch { return toolError('Tool execution failed'); }
  });
}
