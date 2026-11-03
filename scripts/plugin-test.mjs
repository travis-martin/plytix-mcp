import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { validatePlugin } from './plugin-check.mjs';
import { DEFAULT_TOOLS, READ_TOOLS, LOCAL_DRAFT_TOOLS } from '../dist/policy.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repo, 'build/plugin-artifacts/plytix-catalog');
await validatePlugin(source);
const temporary = await mkdtemp(join(tmpdir(), 'plytix-plugin-fixture-'));
const root = join(temporary, 'plytix-catalog');
const client = new Client({ name: 'packaged-plugin-fixture', version: '1' });
try {
  const version = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8')).version;
  const archive = join(repo, 'build/plugin-artifacts', `plytix-catalog-${version}.tgz`);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert(entries.every(name => name.startsWith('plytix-catalog/') && !name.split('/').includes('..') && !name.includes('\\')));
  execFileSync('tar', ['-xzf', archive, '-C', temporary], { stdio: 'pipe' });
  await validatePlugin(root);
  const manifestPath = join(root, 'mcp.json');
  const manifestText = await readFile(manifestPath, 'utf8');
  const invalidManifest = JSON.parse(manifestText);
  invalidManifest.mcpServers['plytix-catalog'].env = { PLYTIX_API_KEY: 'fixture-must-not-ship' };
  await writeFile(manifestPath, JSON.stringify(invalidManifest));
  await assert.rejects(validatePlugin(root), /Credentials and account defaults/);
  await writeFile(manifestPath, manifestText);
  await writeFile(join(root, '.env'), 'FIXTURE_ONLY=must-not-ship');
  await assert.rejects(validatePlugin(root), /Private or dependency files/);
  await rm(join(root, '.env'));
  const guard = join(temporary, 'deny-network.mjs');
  await writeFile(guard, "globalThis.fetch = async () => { throw new Error('Network forbidden in package fixture'); };\n");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && !/^(PLYTIX_|MCP_|DOTENV_|NODE_)/.test(name)));
  Object.assign(environment, {
    PLYTIX_API_KEY: 'fixture', PLYTIX_API_PASSWORD: 'fixture', PLYTIX_WRITE_TOOLS: '[]',
    MCP_KNOWLEDGE_WRITE_TOOLS: '[]', MCP_KNOWLEDGE_CONFIG: '', PLYTIX_PRICING_DIR: '',
    DOTENV_CONFIG_PATH: join(temporary, 'absent.env'),
  });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', pathToFileURL(guard).href, join(root, 'server/index.mjs')],
    cwd: root, env: environment, stderr: 'pipe',
  });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(new Set(tools.map(tool => tool.name)), DEFAULT_TOOLS);
  assert(tools.every(tool => tool.annotations?.readOnlyHint === READ_TOOLS.has(tool.name)));
  assert(tools.filter(tool => LOCAL_DRAFT_TOOLS.has(tool.name)).every(tool => tool.annotations?.destructiveHint === false));
  const result = await client.callTool({ name: 'identifier_detect', arguments: { value: 'ABC-123' } });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.metadata.source, 'local');
  const resource = await client.readResource({ uri: 'plytix://guides/discovery' });
  assert(JSON.stringify(resource).includes('catalog_dictionary'));
  const workspace = await client.readResource({ uri: 'ui://plytix/workspace' });
  assert(workspace.contents[0].text.includes('<script>'));
  assert.equal(workspace.contents[0].mimeType, 'text/html;profile=mcp-app');
  console.log(JSON.stringify({ isolated_archive_startup: 'passed', manifest_rejection: 'passed', default_tools: tools.length, workspace_resource: 'passed', network: 'disabled', credentials: 'fixtures' }));
} finally {
  await client.close();
  // This is a unique directory created by this process, verified under the OS temp directory.
  assert(resolve(temporary).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
  await rm(temporary, { recursive: true, force: true });
}
