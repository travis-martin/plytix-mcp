/** Fresh-process verification. Never print credentials, document data or tool payloads. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
let entry = resolve(repository, 'dist/index.js');
let envFile = resolve(repository, '.env');
let live = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--live') live = true;
  else if ((args[i] === '--entry' || args[i] === '--env-file') && args[i + 1]) {
    const option = args[i]; const value = resolve(args[++i]);
    if (option === '--entry') entry = value; else envFile = value;
  } else {
    console.error('Usage: node scripts/verify-installed.mjs [--entry PATH] [--env-file PATH] [--live]');
    process.exit(2);
  }
}

const environment = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
Object.assign(environment, { DOTENV_CONFIG_PATH: envFile, PLYTIX_WRITE_TOOLS: '[]', MCP_KNOWLEDGE_WRITE_TOOLS: '[]', MCP_KNOWLEDGE_CONFIG: '' });
if (live) {
  // Use the selected private file, not accidentally inherited credentials.
  delete environment.PLYTIX_API_KEY;
  delete environment.PLYTIX_API_PASSWORD;
} else {
  Object.assign(environment, { PLYTIX_API_KEY: 'verification-fixture', PLYTIX_API_PASSWORD: 'verification-fixture', PLYTIX_PRICING_DIR: '', PLYTIX_PRICING_GCS_BUCKET: '' });
}
const client = new Client({ name: 'plytix-installed-verification', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: repository, env: environment, stderr: 'ignore' });
const localDrafts = new Set(['pricing_import', 'pricing_plan']);
let failures = 0;
async function check(name, arguments_ = {}) {
  try {
    const result = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 60_000 });
    const status = result.isError ? 'failed' : result.structuredContent?.metadata?.status === 'partial' ? 'partial' : 'passed';
    if (result.isError) failures++;
    console.log(JSON.stringify({ tool: name, status }));
  } catch { failures++; console.log(JSON.stringify({ tool: name, status: 'protocol_failed' })); }
}
try {
  await access(entry);
  if (live) await access(envFile);
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const required = ['discovery_guide', 'identifier_detect', 'pricing_import', 'pricing_plan', 'pricing_plan_get', 'pricing_rules_get'];
  const names = new Set(tools.map(tool => tool.name));
  if (required.some(name => !names.has(name)) || tools.some(tool => !localDrafts.has(tool.name) && tool.annotations?.readOnlyHint !== true)) throw new Error('Installed catalog mismatch');
  if (tools.filter(tool => localDrafts.has(tool.name)).some(tool => tool.annotations?.destructiveHint !== false || tool.annotations?.readOnlyHint !== false)) throw new Error('Draft annotations mismatch');
  console.log(JSON.stringify({ status: 'connected', tools: tools.length, product_writes_enabled: false, live_reads: live }));
  await check('discovery_guide');
  await check('identifier_detect', { value: 'EXAMPLE-123' });
  if (live) {
    await check('pricing_rules_get');
    await check('families_list', { page_size: 1 });
    await check('products_search', { pagination: { page: 1, page_size: 1 }, attributes: ['sku'] });
  }
  console.log(JSON.stringify({ verification: failures ? 'failed' : 'passed', failures, live_reads: live, mutations: 0 }));
  if (failures) process.exitCode = 1;
} catch {
  console.error('Installed verification failed; check the built entrypoint, private environment file and required tool catalog. No credential or tool payload was logged.');
  process.exitCode = 1;
} finally { await client.close().catch(() => {}); }
