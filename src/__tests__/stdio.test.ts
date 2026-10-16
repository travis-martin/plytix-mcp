import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { READ_TOOLS } from '../policy.js';

it('starts the built stdio entry point and executes a credential-free identifier operation', async () => {
  const client = new Client({ name: 'fixture-stdio', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'],
    env: { ...process.env as Record<string,string>, PLYTIX_API_KEY: 'fixture', PLYTIX_API_PASSWORD: 'fixture', PLYTIX_WRITE_TOOLS: '[]', DOTENV_CONFIG_PATH: 'not-a-real-env-file' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    expect(new Set((await client.listTools()).tools.map(t => t.name))).toEqual(READ_TOOLS);
    const result = await client.callTool({ name: 'identifier_detect', arguments: { value: 'ABC-123' } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('sku');
  } finally { await client.close(); }
});
