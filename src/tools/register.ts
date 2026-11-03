import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitResultSchema, type ElicitRequestFormParams, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';
import { READ_TOOLS, WRITE_TOOLS, KNOWLEDGE_WRITE_TOOLS, LOCAL_DRAFT_TOOLS, parseWriteApprovalMode, type WriteApprovalMode } from '../policy.js';
import type { PlytixClient } from '../client.js';
import type { KnowledgeService } from '../knowledge/service.js';
import { decorateResult, outputSchemaForTool, type ToolResult } from '../results.js';
import { PlytixError } from '../types.js';
import { KnowledgeError } from '../knowledge/model.js';

export interface ToolDefinition {
  title?: string;
  description: string;
  inputSchema: ZodRawShape;
  _meta?: Record<string, unknown>;
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
  /** Explicit operator trust in the host's tool permissions; defaults to a server form. */
  writeApprovalMode?: WriteApprovalMode;
  knowledge?: KnowledgeService;
  knowledgeWriteTools?: ReadonlySet<string>;
}
const policies = new WeakMap<McpServer, ReadonlySet<string>>();
const clients = new WeakMap<McpServer, PlytixClient>();
const approvalProviders = new WeakMap<McpServer, WriteApprovalProvider>();
const approvalModes = new WeakMap<McpServer, WriteApprovalMode>();
const knowledgeServices = new WeakMap<McpServer, KnowledgeService>();
export function configureToolPolicy(
  server: McpServer, writes: ReadonlySet<string>, client: PlytixClient, options: ToolPolicyOptions = {},
) {
  const mode = parseWriteApprovalMode(options.writeApprovalMode);
  if (mode === 'host' && options.requestWriteApproval) {
    throw new Error('Host approval mode cannot be combined with a custom approval provider');
  }
  for (const name of writes) if (!WRITE_TOOLS.has(name)) throw new Error('Unknown write tool');
  for (const name of options.knowledgeWriteTools ?? []) if (!KNOWLEDGE_WRITE_TOOLS.has(name)) throw new Error('Unknown knowledge write tool');
  policies.set(server, new Set([...writes, ...options.knowledgeWriteTools ?? []]));
  clients.set(server, client);
  approvalModes.set(server, mode);
  approvalProviders.delete(server);
  if (options.requestWriteApproval) approvalProviders.set(server, options.requestWriteApproval);
  if (options.knowledge) knowledgeServices.set(server, options.knowledge);
}

type FormRoute = 'openai/elicitation/create' | 'openai/form' | 'elicitation/create';
export const writeApprovalArgumentLimit = (toolName: string): number => toolName === 'pricing_review_apply' ? 64_000 : 16_000;
/** Preserve every validated field; compact only the bounded batch manifest. */
export const serializeWriteApprovalArguments = (toolName: string, args: Record<string, unknown>): string =>
  JSON.stringify(args, null, toolName === 'pricing_review_apply' ? undefined : 2);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Negotiated support is not evidence that a form was displayed or a write approved. */
export function getWriteApprovalSupport(server: McpServer) {
  const mode = approvalModes.get(server) ?? 'form';
  const capabilities = server.server.getClientCapabilities();
  const extensions = capabilities?.extensions;
  const openaiElicitation = extensions?.['openai/elicitation'];
  let route: FormRoute | null = null;
  if (isObject(openaiElicitation) && isObject(openaiElicitation.form)) route = 'openai/elicitation/create';
  else if (isObject(extensions?.['openai/form'])) route = 'openai/form';
  else if (capabilities?.elicitation?.form) route = 'elicitation/create';
  const host = server.server.getClientVersion();
  return { supported: mode === 'host' || route !== null, route: mode === 'host' ? null : route,
    form_supported: route !== null, mode,
    authorization_source: mode === 'host' ? 'host_tool_permission' as const : 'server_form' as const,
    nested_form_required: mode === 'form',
    enabled_write_tools: [...policies.get(server) ?? []].sort(),
    detail: mode === 'host'
      ? 'The operator delegates write authorization to the trusted host tool-permission policy. This server does not verify that a human prompt was displayed or accepted.'
      : 'Each enabled write also requires the server approval form. Negotiated form support does not prove that a human has approved a change.',
    argument_limits: { default: 16_000, pricing_review_apply: 64_000 },
    ...(host ? { host: { name: host.name, version: host.version } } : {}) };
}

/** Only predefined safe messages are exposed; host/provider error text can contain secrets. */
class ApprovalFormError extends Error {}

/** Use the host's negotiated form renderer, not its generic tool-permission prompt. */
async function requestTrustedForm(server: McpServer, params: ElicitRequestFormParams, signal: AbortSignal): Promise<ElicitResult> {
  const { route } = getWriteApprovalSupport(server);
  if (!route) throw new ApprovalFormError('The host did not advertise a supported approval form. Connect a form-capable host and run approval_check. This call did not change data.');
  // OpenAI form extensions are separate JSON-RPC methods, not elicitation modes.
  // Direct MCP connections use the negotiated legacy request protocol.
  // Both forms below have one exact required field, validated by
  // hasExactConfirmation. Keep empty acceptance distinguishable from transport
  // failure instead of losing that diagnosis in SDK schema validation.
  return server.server.request({ method: route, params }, ElicitResultSchema, { signal, timeout: 30_000 });
}

function hasExactConfirmation(response: ElicitResult, confirmation: string): boolean {
  if (response.action !== 'accept') return false;
  if (!response.content || typeof response.content.confirmation !== 'string') {
    throw new ApprovalFormError('The host returned acceptance without the required form input. A generic permission acceptance is not write approval. Run approval_check in a form-capable host; this call did not change data.');
  }
  return response.content.confirmation === confirmation;
}

/** The host must return the user's exact form input; unattended hosts fail closed. */
export const elicitWriteApproval: WriteApprovalProvider = async (request, server) => {
  const response = await requestTrustedForm(server, {
    mode: 'form',
    message: `Approve one ${KNOWLEDGE_WRITE_TOOLS.has(request.toolName) ? 'shared knowledge proposal' : 'Plytix data change'}: ${request.toolName}\n` +
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
  }, request.signal);
  return hasExactConfirmation(response, 'APPROVE');
};

/** Harmless input round trip: never grants write authorization or persists data. */
export async function elicitApprovalCheck(server: McpServer) {
  const support = getWriteApprovalSupport(server);
  if (support.mode === 'host') {
    return { ...support, verified: false, write_authorized: false as const,
      message: 'No additional server form is required in host mode. Review and authorize writes through the trusted host. This diagnostic does not verify host permission settings or approve a write.' };
  }
  try {
    const response = await requestTrustedForm(server, {
      mode: 'form',
      message: 'Harmless approval-form check. Type CHECK to verify that you can see this form and submit its input. This does not approve or execute any data changes.',
      requestedSchema: {
        type: 'object', properties: { confirmation: { type: 'string', title: 'Type CHECK to verify this form' } }, required: ['confirmation'],
      },
    }, AbortSignal.timeout(30_000));
    return { ...support, verified: hasExactConfirmation(response, 'CHECK'), action: response.action, write_authorized: false as const };
  } catch (error) {
    return { ...support, verified: false, write_authorized: false as const,
      message: error instanceof ApprovalFormError ? error.message : 'Approval form check did not complete. No changes were approved or made.' };
  }
}

const toolError = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

export function registerTool<TArgs extends Record<string, unknown>>(
  server: McpServer, name: string, definition: ToolDefinition,
  handler: (args: TArgs) => Promise<ToolResult>,
): void {
  const readOnly = READ_TOOLS.has(name);
  const draftOnly = LOCAL_DRAFT_TOOLS.has(name);
  if (!readOnly && !draftOnly && !WRITE_TOOLS.has(name) && !KNOWLEDGE_WRITE_TOOLS.has(name)) throw new Error(`Unclassified tool: ${name}`);
  if (!readOnly && !draftOnly && !policies.get(server)?.has(name)) return;
  // Erase SDK/Zod recursive inference only at this boundary. SDK validates inputs.
  (server.registerTool as any)(name, {
    ...definition,
    outputSchema: outputSchemaForTool(name),
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly && !draftOnly, idempotentHint: readOnly, openWorldHint: true },
  }, async (args: TArgs, extra: { signal: AbortSignal }) => {
    const started = new Date().toISOString();
    const client = clients.get(server)!;
    try {
      const execute = async (): Promise<ToolResult> => {
        if (readOnly || draftOnly) {
          const result = await handler(args);
          try { await knowledgeServices.get(server)?.observe(name, result); }
          catch {
            result.resultMetadata = { ...result.resultMetadata, learning: { status: 'unavailable' }, warnings: [
              ...result.resultMetadata?.warnings ?? [],
              'Shared schema learning was unavailable; this result does not confirm persistence.',
            ] };
          }
          return result;
        }
        const mode = approvalModes.get(server) ?? 'form';
        const approve = approvalProviders.get(server);
        if (mode === 'form' && !approve) return toolError('Write approval is unavailable. This call did not change data.');
        const argumentsJson = serializeWriteApprovalArguments(name, args);
        if (argumentsJson.length > writeApprovalArgumentLimit(name)) {
          return toolError('Write arguments exceed the approval review limit. Reduce this change before requesting approval.');
        }
        if (mode === 'form') {
          const approvalSignal = AbortSignal.any([extra.signal, AbortSignal.timeout(30_000)]);
          const request = Object.freeze({ toolName: name, argumentsJson, signal: approvalSignal });
          let approved = false;
          try {
            approved = (await new Promise<boolean>((resolve, reject) => {
              const abort = () => reject(new Error('Write approval cancelled'));
              approvalSignal.addEventListener('abort', abort, { once: true });
              if (approvalSignal.aborted) { abort(); return; }
              Promise.resolve().then(() => approve!(request, server)).then(resolve, reject).finally(() => {
                approvalSignal.removeEventListener('abort', abort);
              });
            })) === true;
          } catch (error) { return toolError(error instanceof ApprovalFormError ? error.message : 'Write approval was not completed. This call did not change data.'); }
          if (!approved || approvalSignal.aborted) {
            return toolError('Write was not approved. This call did not change data.');
          }
        }
        // Host mode relies on the explicitly trusted client's tool permissions;
        // it does not manufacture a form response or infer human confirmation.
        if (extra.signal.aborted) return toolError('Write was cancelled. This call did not change data.');
        if (KNOWLEDGE_WRITE_TOOLS.has(name)) knowledgeServices.get(server)!.beginApprovedProposal();
        else client.beginApprovedWrite();
        return handler(JSON.parse(argumentsJson) as TArgs);
      };
      return await client.runOperation(async () =>
        decorateResult(name, await execute(), started, client.getReadEvidence()),
      extra.signal, KNOWLEDGE_WRITE_TOOLS.has(name) ? undefined : name);
    } catch (error) {
      return decorateResult(name, toolError(error instanceof PlytixError || error instanceof KnowledgeError ? error.message : 'Tool execution failed'), started, []);
    }
  });
}
