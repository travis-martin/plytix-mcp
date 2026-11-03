import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PlytixClient } from '../client.js';
import { createServer } from '../server.js';
import { WORKSPACE_URI } from '../tools/workspace.js';

it('opens a read-only workspace through the shared server with a self-contained app resource', async () => {
  const server = createServer(new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture' }));
  const client = new Client({ name: 'workspace-fixture', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  try {
    const tool = (await client.listTools()).tools.find(item => item.name === 'catalog_workspace');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?._meta?.ui).toEqual({ resourceUri: WORKSPACE_URI });
    const result: any = await client.callTool({ name: 'catalog_workspace', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.data.tabs).toEqual(['products', 'dictionary', 'pricing']);
    const direct: any = await client.callTool({ name: 'catalog_workspace', arguments: { review_id: '33333333-3333-4333-8333-333333333333' } });
    expect(direct.isError).not.toBe(true);
    expect(direct.structuredContent.data.review_id).toBe('33333333-3333-4333-8333-333333333333');
    const resource = await client.readResource({ uri: WORKSPACE_URI });
    const html = resource.contents[0] as { text: string; mimeType: string; _meta?: any };
    expect(html.mimeType).toBe('text/html;profile=mcp-app');
    expect(html._meta.ui.csp.connectDomains).toEqual([]);
    expect(html.text).toContain('Catalog Workspace');
    expect(html.text.includes('<!-- APP_SCRIPT -->')).toBe(false);
    expect(html.text).not.toMatch(/<script[^>]+src=/);
    expect(html.text).toContain('pricing_plan_get');
    expect(html.text).not.toContain('pricing_apply');
  } finally { await client.close(); await server.close(); }
});
