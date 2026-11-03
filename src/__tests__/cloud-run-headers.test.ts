import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseHelperArgs, gcloudInvocation, produceHelperOutput, main } from '../../scripts/cloud-run-headers.mjs';

let directory: string;
let options: { envFile: string; account: string; gcloud: string; check: boolean };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cloud-run-headers-fixture-'));
  options = { envFile: join(directory, 'credentials.env'), account: 'fixture@example.test', gcloud: process.execPath, check: false };
  await writeFile(options.envFile, 'MCP_AUTH_TOKEN="fixture-token-123456789012345678901234567890"\nPLYTIX_API_KEY="fixture-key"\nPLYTIX_API_PASSWORD="fixture-password"\n');
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('captures gcloud output privately with fixed arguments and a bounded hidden subprocess', async () => {
  const execute = vi.fn().mockResolvedValue({ stdout: 'fixture.payload.signature\n' });
  const result = await produceHelperOutput(options, execute);
  expect(result).toEqual({ Authorization: 'Bearer fixture.payload.signature', 'X-MCP-Token': 'fixture-token-123456789012345678901234567890', 'X-Plytix-API-Key': 'fixture-key', 'X-Plytix-API-Password': 'fixture-password' });
  expect(execute).toHaveBeenCalledWith(process.execPath, ['auth', 'print-identity-token', '--account=fixture@example.test', '--quiet'], expect.objectContaining({ timeout: 7000, maxBuffer: 65536, windowsHide: true }));
  expect(JSON.stringify(execute.mock.calls)).not.toContain('fixture-password');
});

it('check mode returns only booleans and never starts gcloud', async () => {
  const execute = vi.fn();
  expect(await produceHelperOutput({ ...options, check: true }, execute)).toEqual({ configuration_valid: true, token_acquisition_attempted: false });
  expect(execute).not.toHaveBeenCalled();
});

it('runs the check CLI with fixtures without exposing header values', () => {
  const result = execFileSync(process.execPath, ['scripts/cloud-run-headers.mjs', '--env-file', options.envFile, '--account', options.account, '--gcloud', options.gcloud, '--check'], { encoding: 'utf8', windowsHide: true });
  expect(JSON.parse(result)).toEqual({ configuration_valid: true, token_acquisition_attempted: false });
  expect(result).not.toMatch(/fixture-key|fixture-password|fixture-token/);
});

it.each(['--bogus', 'positional', '--account=bad&whoami@example.test', '--account=bad%COMSPEC%@example.test'])('rejects unknown/unsafe configuration without reflecting arguments (%s)', argument => {
  expect(() => parseHelperArgs(['--env-file', options.envFile, '--account', options.account, '--gcloud', options.gcloud, argument])).toThrow('Cloud Run authentication helper failed');
});

it('requires absolute paths and excludes Windows command expansion/injection', () => {
  const base = ['--env-file', 'C:/private/.env', '--account', 'fixture@example.test'];
  expect(() => parseHelperArgs([...base, '--gcloud', 'gcloud.cmd'], 'win32')).toThrow();
  for (const unsafe of ['C:/Tools/a&b.cmd', 'C:/%EVIL%/gcloud.cmd', 'C:/Tools/gcloud".cmd']) {
    expect(() => parseHelperArgs([...base, '--gcloud', unsafe], 'win32')).toThrow();
  }
  const parsed = parseHelperArgs([...base, '--gcloud', 'C:/Program Files/Google/gcloud.cmd'], 'win32');
  expect(gcloudInvocation(parsed, 'win32', { SystemRoot: 'C:\\Windows' })).toEqual({
    executable: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', '""C:/Program Files/Google/gcloud.cmd" auth print-identity-token --account=fixture@example.test --quiet"'],
    windowsVerbatimArguments: true,
  });
});

it('passes a configured PowerShell gcloud launcher as an argument without changing execution policy', () => {
  const invocation = gcloudInvocation({ ...options, gcloud: 'C:/Google SDK/gcloud.ps1' }, 'win32', { SystemRoot: 'C:\\Windows' });
  expect(invocation.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  expect(invocation.args).toEqual(['-NoProfile', '-NonInteractive', '-File', 'C:/Google SDK/gcloud.ps1', 'auth', 'print-identity-token', '--account=fixture@example.test', '--quiet']);
  expect(invocation.windowsVerbatimArguments).toBe(false);
});

it.runIf(process.platform === 'win32')('runs a fixture cmd launcher through a path containing spaces', async () => {
  const launcher = join(directory, 'fixture cloud.cmd');
  await writeFile(launcher, '@echo off\r\nif not "%1"=="auth" exit /b 7\r\nif not "%2"=="print-identity-token" exit /b 8\r\necho fixture.payload.signature\r\n');
  const result = await produceHelperOutput({ ...options, gcloud: launcher });
  expect(result.Authorization).toBe('Bearer fixture.payload.signature');
});

it.each(['invalid-token', 'fixture.payload.signature\nSECRET', ''])('rejects invalid token output without reflecting it', async stdout => {
  await expect(produceHelperOutput(options, vi.fn().mockResolvedValue({ stdout }))).rejects.toThrow('Cloud Run authentication helper failed');
});

it('sanitizes child process errors including captured credentials and command output', async () => {
  const execute = vi.fn().mockRejectedValue(Object.assign(new Error('fixture-password'), { stderr: 'fixture-token', stdout: 'private-output' }));
  await expect(produceHelperOutput(options, execute)).rejects.toThrow(/^Cloud Run authentication helper failed; verify private configuration and existing gcloud sign-in\.$/);
});

it('fails closed for unsafe/missing credentials without starting the subprocess', async () => {
  await writeFile(options.envFile, 'MCP_AUTH_TOKEN=short\nPLYTIX_API_KEY=fixture-key\nPLYTIX_API_PASSWORD="fixture-password\\nInjected: header"\n');
  const execute = vi.fn();
  await expect(produceHelperOutput(options, execute)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});

it('prints only generic failure information and never throws raw config errors', async () => {
  const output = { write: vi.fn() }, errors = { write: vi.fn() };
  expect(await main(['--env-file', 'private-secret-input'], output, errors)).toBe(1);
  expect(output.write).not.toHaveBeenCalled();
  expect(errors.write).toHaveBeenCalledWith('Cloud Run authentication helper failed; verify private configuration and existing gcloud sign-in.\n');
  errors.write.mockClear();
  expect(await main(['--check', '--env-file', 'private-secret-input'], output, errors)).toBe(1);
  expect(errors.write).not.toHaveBeenCalled();
  expect(output.write).toHaveBeenCalledWith('{"configuration_valid":false,"token_acquisition_attempted":false}\n');
});
