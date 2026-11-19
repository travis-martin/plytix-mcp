import { afterEach, beforeEach, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareRemoteProfile, remoteConnection } from '../../scripts/plugin-prepare-remote.mjs';

let repo: string;
let connection: { url: string; env_file: string; account: string; gcloud: string };
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'plytix-remote-plugin-'));
  connection = { url: 'https://fixture.example.test/mcp', env_file: join(repo, '.env'), account: 'fixture@example.test', gcloud: process.execPath };
  await writeFile(connection.env_file, 'SECRET_FIXTURE_MUST_NOT_BE_COPIED');
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

it('builds a remote connection that references the existing helper and credential file', () => {
  const server = remoteConnection({ ...connection, startup_timeout_sec: 45, tool_timeout_sec: 180 }, repo);
  expect(server).toEqual({ type: 'streamable-http', url: connection.url, http_headers_helper: expect.stringContaining('--account "fixture@example.test"'), startup_timeout_sec: 45, tool_timeout_sec: 180 });
  expect(server.http_headers_helper).toContain('--env-file "' + connection.env_file + '"');
  expect(server.http_headers_helper).not.toContain('SECRET_FIXTURE');
});

it('builds machine authentication without depending on an account or gcloud', () => {
  const input = { url: connection.url, env_file: connection.env_file, machine_config: join(repo, 'machine-auth.json') };
  const server = remoteConnection(input, repo);
  expect(server.http_headers_helper).toContain('--machine-config "' + input.machine_config + '"');
  expect(server.http_headers_helper).not.toMatch(/--account|--gcloud|SECRET_FIXTURE/);
  expect(server.url).toBe(connection.url);
});

it('rejects mixed authentication modes and unsafe machine configuration paths', () => {
  const machine_config = join(repo, 'machine-auth.json');
  expect(() => remoteConnection({ ...connection, machine_config }, repo)).toThrow('Choose one authentication mode');
  for (const extra of [{ account: connection.account }, { gcloud: connection.gcloud }, { account: undefined }, { gcloud: undefined }]) {
    expect(() => remoteConnection({ url: connection.url, env_file: connection.env_file, machine_config, ...extra }, repo)).toThrow('Choose one authentication mode');
  }
  for (const fragment of ['"', '$(', '`', '&', '|', '>', '<', '%', '!', '^', '\n']) {
    expect(() => remoteConnection({ url: connection.url, env_file: connection.env_file, machine_config: machine_config + fragment }, repo)).toThrow();
  }
  for (const unsafe of ['relative.json', '', null]) {
    expect(() => remoteConnection({ url: connection.url, env_file: connection.env_file, machine_config: unsafe }, repo)).toThrow();
  }
});

it('rejects raw headers, arbitrary helpers and embedded URL credentials', () => {
  for (const bad of [{ headers: { Authorization: 'secret' } }, { http_headers_helper: 'whoami' }, { url: 'https://user:secret@example.test/mcp' }, { url: 'https://example.test/mcp?token=secret' }, { url: 'http://example.test/mcp' }]) {
    expect(() => remoteConnection({ ...connection, ...bad }, repo)).toThrow();
  }
});

it('rejects shell expansions and operators in every interpolated path or account', () => {
  for (const fragment of ['"', '$(', '`', '&', '|', '>', '<', '%', '!', '^', '\n']) {
    expect(() => remoteConnection({ ...connection, env_file: connection.env_file + fragment }, repo)).toThrow();
    expect(() => remoteConnection({ ...connection, gcloud: connection.gcloud + fragment }, repo)).toThrow();
    expect(() => remoteConnection(connection, repo + fragment)).toThrow();
    expect(() => remoteConnection({ ...connection, account: 'fixture' + fragment + '@example.test' }, repo)).toThrow();
  }
});

it.each(['legacy', 'machine'])('prepares a native remote %s profile without replacing local history, secrets or the portable artifact', async mode => {
  const source = join(repo, 'build/plugin-artifacts/plytix-catalog');
  await cp(resolve('plugin/plytix-catalog'), source, { recursive: true });
  for (const directory of ['server', 'ui']) await mkdir(join(source, directory));
  await writeFile(join(source, 'server/index.mjs'), '// fixture');
  await writeFile(join(source, 'ui/workspace.html'), '<html></html>');
  await cp(resolve('LICENSE'), join(source, 'LICENSE'));
  await writeFile(join(source, 'README.md'), 'Fixture documentation');
  const local = join(repo, '.local/plugin-marketplace/plugins/plytix-catalog');
  await mkdir(local, { recursive: true });
  await writeFile(join(local, 'keep.txt'), 'local history');
  const machine_config = join(repo, 'machine-auth.json');
  const input = mode === 'machine' ? { url: connection.url, env_file: connection.env_file, machine_config } : connection;
  if (mode === 'machine') await writeFile(machine_config, JSON.stringify({ public_metadata_only: 'CONFIG_FIXTURE_MUST_NOT_BE_COPIED' }));
  const metadata = join(repo, 'connection.json');
  await writeFile(metadata, JSON.stringify(input));
  const result = await prepareRemoteProfile(repo, metadata);
  const config = JSON.parse(await readFile(join(result.plugin, '.mcp.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(result.plugin, '.codex-plugin/plugin.json'), 'utf8'));
  expect(config.mcpServers['plytix-catalog']).toEqual(remoteConnection(input, repo));
  expect(manifest.name).toBe('plytix-catalog');
  expect(manifest.interface.displayName).toBe('Plytix Studio');
  expect(manifest.mcpServers).toBe('./.mcp.json');
  expect((await readdir(join(result.plugin, 'skills'))).length).toBe(4);
  expect(await readdir(result.plugin)).not.toContain('plugin.json');
  expect(await readdir(result.plugin)).not.toContain('.env');
  expect(await readdir(result.plugin)).not.toContain('machine-auth.json');
  expect(JSON.stringify(config)).not.toMatch(/SECRET_FIXTURE|CONFIG_FIXTURE/);
  expect(await readFile(join(local, 'keep.txt'), 'utf8')).toBe('local history');
  expect(JSON.parse(await readFile(join(source, 'mcp.json'), 'utf8')).mcpServers['plytix-catalog'].type).toBe('stdio');
  expect(await prepareRemoteProfile(repo, metadata)).toEqual(result);
  if (mode === 'machine') {
    await rm(machine_config);
    await expect(prepareRemoteProfile(repo, metadata)).rejects.toThrow();
    await writeFile(machine_config, JSON.stringify({ public_metadata_only: 'CONFIG_FIXTURE_MUST_NOT_BE_COPIED' }));
  }
  await writeFile(join(result.plugin, '.mcp.json'), '{}');
  await expect(prepareRemoteProfile(repo, metadata)).rejects.toThrow('Existing connection differs');
  expect(await readFile(join(result.plugin, '.mcp.json'), 'utf8')).toBe('{}');
});
