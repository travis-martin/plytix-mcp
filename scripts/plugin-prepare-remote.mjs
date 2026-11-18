import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseHelperArgs } from './cloud-run-headers.mjs';
import { validatePlugin } from './plugin-check.mjs';

const SAFE_ERROR = 'Remote plugin preparation failed; inspect the private connection metadata. No credentials or raw configuration were logged.';
const fields = new Set(['url', 'env_file', 'account', 'gcloud', 'startup_timeout_sec', 'tool_timeout_sec']);
const safePath = value => typeof value === 'string' && isAbsolute(value) && !/["&|<>^%!$`\r\n\0]/.test(value);

export function remoteConnection(input, repo) {
  assert(input && typeof input === 'object' && !Array.isArray(input));
  assert(Object.keys(input).every(key => fields.has(key)), 'Unsupported connection field');
  const url = new URL(input.url);
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'Use the verified private HTTPS endpoint without credentials');
  assert(safePath(input.env_file) && safePath(input.gcloud), 'Use private absolute configuration paths');
  const helper = join(repo, 'scripts/cloud-run-headers.mjs').replaceAll('\\', '/');
  assert(safePath(helper));
  const parsed = parseHelperArgs(['--env-file', input.env_file, '--account', input.account, '--gcloud', input.gcloud]);
  const startup = input.startup_timeout_sec ?? 30, tool = input.tool_timeout_sec ?? 120;
  assert(Number.isFinite(startup) && startup > 0 && startup <= 300);
  assert(Number.isFinite(tool) && tool > 0 && tool <= 600);
  return {
    type: 'streamable-http', url: url.href,
    http_headers_helper: `node "${helper}" --env-file "${parsed.envFile}" --account "${parsed.account}" --gcloud "${parsed.gcloud}"`,
    startup_timeout_sec: startup, tool_timeout_sec: tool,
  };
}

async function noLink(path) {
  try { assert(!(await lstat(path)).isSymbolicLink(), 'Profile path cannot be a symlink'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function prepareRemoteProfile(repo, connectionFile) {
  repo = resolve(repo);
  const source = join(repo, 'build/plugin-artifacts/plytix-catalog');
  await validatePlugin(source);
  const input = JSON.parse(await readFile(connectionFile, 'utf8'));
  const server = remoteConnection(input, repo);
  // Existence only: never read or copy the private credential file.
  await access(input.env_file); await access(input.gcloud);
  const portable = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'));
  const presentation = structuredClone(portable.extensions['com.openai'].interface);
  presentation.shortDescription = 'Remote catalog and pricing';
  presentation.longDescription = 'Use the existing private remote Plytix service for catalog exploration and reviewed price-list updates. Workflow guidance and reviews use the remote storage. This desktop connection uses the existing local authentication helper.';
  const digest = createHash('sha256').update(JSON.stringify({ server, portable })).digest('hex').slice(0, 12);
  const version = `${portable.version.split('+')[0]}+remote.${digest}`;
  const marketplace = join(repo, '.local/plugin-marketplace');
  const profiles = join(marketplace, 'profiles/remote');
  const parent = join(profiles, version), target = join(parent, 'plytix-catalog');
  assert.equal(relative(profiles, target).replaceAll('\\', '/'), `${version}/plytix-catalog`);
  for (const path of [join(repo, '.local'), marketplace, join(marketplace, 'profiles'), profiles, parent, target]) await noLink(path);
  const manifest = { name: portable.name, version, description: portable.description, license: portable.license,
    skills: './skills', mcpServers: './.mcp.json', interface: presentation };
  const native = { mcpServers: { 'plytix-catalog': server } };
  let exists = true;
  try { await access(target); }
  catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
  if (exists) {
    assert.deepEqual(JSON.parse(await readFile(join(target, '.codex-plugin/plugin.json'), 'utf8')), manifest, 'Existing profile differs');
    assert.deepEqual(JSON.parse(await readFile(join(target, '.mcp.json'), 'utf8')), native, 'Existing connection differs');
  } else {
    // Never replace the selected marketplace package or an installed cache.
    await mkdir(target, { recursive: true });
    await cp(join(source, 'skills'), join(target, 'skills'), { recursive: true, dereference: false });
    if ((await readdir(source)).includes('assets')) await cp(join(source, 'assets'), join(target, 'assets'), { recursive: true, dereference: false });
    await cp(join(source, 'LICENSE'), join(target, 'LICENSE'));
    await cp(join(source, 'README.md'), join(target, 'README.md'));
    await mkdir(join(target, '.codex-plugin'));
    await writeFile(join(target, '.codex-plugin/plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(target, '.mcp.json'), JSON.stringify(native, null, 2) + '\n');
  }
  // The native Codex format is intentional: its HTTP configuration supports
  // dynamic header helpers, which the portable Agent Plugins HTTP schema lacks.
  assert(!(await readdir(target)).includes('plugin.json'));
  for (const asset of [presentation.logo, presentation.composerIcon].filter(Boolean)) {
    assert(asset.startsWith('./assets/') && !asset.includes('..'));
    await access(join(target, asset));
  }
  return { plugin: target, marketplace, source_path: './' + relative(marketplace, target).replaceAll('\\', '/'),
    plugin_id: `${portable.name}@plytix-local`, display_name: presentation.displayName, version,
    transport: 'remote HTTP with existing local header helper', credentials_copied: false,
    activation: 'Prepared only. Select this source in the existing private marketplace, install through Codex, and disable the duplicate standalone connection after verification.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'connection-file': { type: 'string' } }, allowPositionals: false, strict: true });
    assert(values['connection-file'] && isAbsolute(values['connection-file']));
    console.log(JSON.stringify(await prepareRemoteProfile(resolve(dirname(fileURLToPath(import.meta.url)), '..'), values['connection-file'])));
  } catch { console.error(SAFE_ERROR); process.exitCode = 1; }
}
