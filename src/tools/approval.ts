import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { elicitApprovalCheck, getWriteApprovalSupport, registerTool } from './register.js';

export function registerApprovalTools(server: McpServer) {
  registerTool(server, 'approval_capabilities', {
    title: 'Inspect Write Permission Mode',
    description: 'Read the configured authorization mode, enabled write tools and form support. Host mode uses client tool permissions without a second form; form mode requires the server form. Does not grant approval or change data.',
    inputSchema: {},
  }, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ ...getWriteApprovalSupport(server), write_authorized: false }) }],
    resultMetadata: { source: 'local', freshness: 'not_applicable' },
  }));
  registerTool(server, 'approval_check', {
    title: 'Check Approval Form Without Changing Data',
    description: 'In form mode, show a harmless CHECK form. In host mode, report delegated client authorization without showing a form. Never approves a write or changes data.',
    inputSchema: {},
  }, async () => ({
    content: [{ type: 'text', text: JSON.stringify(await elicitApprovalCheck(server)) }],
    resultMetadata: { source: 'local', freshness: 'not_applicable' },
  }));
}
