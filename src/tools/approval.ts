import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { elicitApprovalCheck, getWriteApprovalSupport, registerTool } from './register.js';

export function registerApprovalTools(server: McpServer) {
  registerTool(server, 'approval_capabilities', {
    title: 'Inspect Approval Form Support',
    description: 'Read negotiated host form support. Does not show a form, grant approval, or change data. Advertised support alone does not prove the form is visible.',
    inputSchema: {},
  }, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ ...getWriteApprovalSupport(server), write_authorized: false }) }],
    resultMetadata: { source: 'local', freshness: 'not_applicable' },
  }));
  registerTool(server, 'approval_check', {
    title: 'Check Approval Form Without Changing Data',
    description: 'Show a harmless CHECK form using the negotiated host route. Verifies submitted form input only; never approves a write or changes data. Use before retrying a missing approval form.',
    inputSchema: {},
  }, async () => ({
    content: [{ type: 'text', text: JSON.stringify(await elicitApprovalCheck(server)) }],
    resultMetadata: { source: 'local', freshness: 'not_applicable' },
  }));
}
