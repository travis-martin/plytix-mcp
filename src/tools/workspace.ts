import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';

export const WORKSPACE_URI = 'ui://plytix/workspace';
export function registerWorkspaceTools(server: McpServer) {
  registerTool(server, 'catalog_workspace', {
    title: 'Catalog Workspace',
    description: 'Open the product inspector, reviewed catalog dictionary and price-list preparation workspace. Price changes require separate exact host approval.',
    inputSchema: {},
    _meta: {
      ui: { resourceUri: WORKSPACE_URI },
      'openai/ui': { entrypoints: [{ type: 'global' }] },
    },
  }, async () => ({ content: [{ type: 'text', text: JSON.stringify({
    tabs: ['products', 'dictionary', 'pricing'],
    instructions: 'Inspect candidates and evidence. Review family mappings before preparing price updates. Attach the exact plan to the conversation for approval.',
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
