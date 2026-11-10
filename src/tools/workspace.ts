import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool } from './register.js';

export const WORKSPACE_URI = 'ui://plytix/workspace';
export const REVIEW_UI_META = { ui: { resourceUri: WORKSPACE_URI } };
export function registerWorkspaceTools(server: McpServer) {
  registerTool<{ review_id?: string }>(server, 'catalog_workspace', {
    title: 'Catalog Workspace',
    description: 'Open the product inspector, catalog dictionary and price-list review workspace. Supply review_id to open a saved review with its line decisions and execution statuses. Price changes require separate exact host approval.',
    inputSchema: { review_id: z.string().uuid().optional().describe('Saved pricing review to open directly') },
    _meta: {
      ui: { resourceUri: WORKSPACE_URI },
      'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] },
    },
  }, async ({ review_id }) => ({ content: [{ type: 'text', text: JSON.stringify({
    tabs: ['products', 'dictionary', 'pricing'],
    ...(review_id ? { review_id } : {}),
    instructions: 'Inspect candidates and evidence. Review family mappings and all line decisions before preparing selected changes. Draft decisions are not approval to change Plytix; request trusted approval of the exact prepared changes.',
  }) }] }));
  server.registerResource('catalog-workspace', WORKSPACE_URI, {
    title: 'Catalog Workspace', description: 'Product and pricing review workspace', mimeType: 'text/html;profile=mcp-app',
  }, async uri => ({ contents: [{
    uri: uri.href, mimeType: 'text/html;profile=mcp-app',
    text: await readFile(new URL(import.meta.url.endsWith('.ts') ? '../../dist/ui/workspace.html' : '../ui/workspace.html', import.meta.url), 'utf8'),
    _meta: {
      ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
      'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] },
    },
  }] }));
}
