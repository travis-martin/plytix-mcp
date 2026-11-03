import assert from 'node:assert/strict';
import { mkdir, cp, readFile, writeFile, access, rm, lstat } from 'node:fs/promises';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlugin } from './plugin-check.mjs';
import { WRITE_TOOLS } from '../dist/policy.js';

const args = process.argv.slice(2);
if (args.some(arg => !['--host-writes', '--all-write-tools'].includes(arg))) throw new Error('Unknown private preparation option');
const hostWrites = args.includes('--host-writes');
const writes = args.includes('--all-write-tools') ? [...WRITE_TOOLS] : ['pricing_rules_save', 'pricing_apply', 'pricing_review_apply'];

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repo, 'build/plugin-artifacts/plytix-catalog');
await validatePlugin(source);
// Check existence only; credentials remain in their original ignored file.
await access(join(repo, '.env'));
const marketplace = join(repo, '.local/plugin-marketplace');
const target = join(marketplace, 'plugins/plytix-catalog');
assert.equal(relative(marketplace, target).replaceAll('\\', '/'), 'plugins/plytix-catalog');
for (const path of [marketplace, join(marketplace, 'plugins'), target]) {
  try { assert(!(await lstat(path)).isSymbolicLink(), 'Private install path cannot be a symlink'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await mkdir(join(marketplace, '.agents/plugins'), { recursive: true });
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
const config = JSON.parse(await readFile(join(target, 'mcp.json'), 'utf8'));
config.mcpServers['plytix-catalog'].env = {
  DOTENV_CONFIG_PATH: join(repo, '.env'),
  PLYTIX_PRICING_DIR: join(repo, '.local/pricing'),
  PLYTIX_WRITE_TOOLS: JSON.stringify(writes),
  MCP_WRITE_APPROVAL_MODE: hostWrites ? 'host' : 'form',
};
await writeFile(join(target, 'mcp.json'), JSON.stringify(config, null, 2) + '\n');
await cp(join(repo, 'plugin/marketplace.json'), join(marketplace, '.agents/plugins/marketplace.json'));
console.log(JSON.stringify({
  marketplace, plugin: target, credentials: 'Original .env referenced by path only; no values copied',
  writes, approval: hostWrites ? 'Trusted host tool permissions; no duplicate form' : 'Exact-action host form required for every write',
  next_commands: [`codex plugin marketplace add "${marketplace}" --json`, 'codex plugin add plytix-catalog@plytix-local --json'],
}));
