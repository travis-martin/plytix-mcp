import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseHelperArgs, helperArgs, gcloudInvocation, produceHelperOutput, main } from '../../scripts/cloud-run-headers.mjs';

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
  await expect(produceHelperOutput(options, execute)).rejects.toThrow(/^Cloud Run authentication helper failed; verify private configuration and the selected authentication method\.$/);
});

it.each(['Reauthentication required.', 'Reauthentication is required.', 'reauth related error (invalid_rapt)'])('reports an actionable fixed reauthentication error without exposing subprocess details (%s)', async marker => {
  const output = { write: vi.fn() }, errors = { write: vi.fn() };
  const execute = vi.fn().mockRejectedValue(Object.assign(new Error('fixture-password'), {
    code: 1, stderr: `${marker} fixture@example.test fixture-password fixture.payload.signature`, stdout: 'fixture-key',
  }));
  const args = ['--env-file', options.envFile, '--account', options.account, '--gcloud', options.gcloud];
  expect(await main(args, output, errors, execute)).toBe(1);
  expect(output.write).not.toHaveBeenCalled();
  expect(errors.write).toHaveBeenCalledExactlyOnceWith('Google Cloud requires reauthentication. Privately run gcloud auth login <configured-account> --no-activate, then reconnect Plytix.\n');
  expect(JSON.stringify(errors.write.mock.calls)).not.toMatch(/fixture-password|fixture-key|fixture@example|fixture\.payload/);
});

it.each([
  { stderr: 'invalid_grant: unrelated credential failure', killed: false },
  { stderr: 'Reauthentication required.', killed: true },
  { stderr: 'Reauthentication disabled by configuration', killed: false },
])('keeps other subprocess failures generic instead of guessing a reauthentication cause (%j)', async details => {
  const execute = vi.fn().mockRejectedValue(Object.assign(new Error('private-error'), details));
  await expect(produceHelperOutput(options, execute)).rejects.toThrow(/^Cloud Run authentication helper failed; verify private configuration and the selected authentication method\.$/);
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
  expect(errors.write).toHaveBeenCalledWith('Cloud Run authentication helper failed; verify private configuration and the selected authentication method.\n');
  errors.write.mockClear();
  expect(await main(['--check', '--env-file', 'private-secret-input'], output, errors)).toBe(1);
  expect(errors.write).not.toHaveBeenCalled();
  expect(output.write).toHaveBeenCalledWith('{"configuration_valid":false,"token_acquisition_attempted":false}\n');
});

it('serializes either complete authentication mode and rejects mixed modes', () => {
  const parsed = parseHelperArgs(['--env-file', 'C:/private/headers.env', '--machine-config', 'C:/private/machine.json'], 'win32');
  expect(parsed).toEqual({ envFile: 'C:/private/headers.env', machineConfig: 'C:/private/machine.json', check: false });
  expect(helperArgs(parsed, 'win32')).toEqual(['--env-file', 'C:/private/headers.env', '--machine-config', 'C:/private/machine.json']);
  expect(helperArgs(options)).toEqual(['--env-file', options.envFile, '--account', options.account, '--gcloud', options.gcloud]);
  for (const extra of [['--account', 'fixture@example.test'], ['--gcloud', 'C:/gcloud.cmd'], ['--machine-config', 'C:/private/again.json']]) {
    expect(() => parseHelperArgs([...helperArgs(parsed, 'win32'), ...extra], 'win32')).toThrow();
  }
  expect(() => helperArgs({ ...parsed, account: 'fixture@example.test' }, 'win32')).toThrow();
  expect(() => parseHelperArgs(['--env-file', 'C:/private/headers.env', '--machine-config', 'relative.json'], 'win32')).toThrow();
});

it.runIf(process.platform === 'win32')('uses the TPM token path without invoking gcloud and keeps check mode offline', async () => {
  const machineConfig = join(directory, 'machine.json');
  const now = 1800000000;
  const metadata = { version: 1, type: 'windows-tpm', serviceAccount: 'fixture@fixture-project.iam.gserviceaccount.com',
    keyId: 'a'.repeat(40), certificateThumbprint: 'B'.repeat(40), audience: 'https://fixture-service.run.app' };
  await writeFile(machineConfig, JSON.stringify(metadata));
  const machineOptions = { envFile: options.envFile, machineConfig, check: false };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = Buffer.alloc(256, 1).toString('base64url');
  const token = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'fixture' })}.${encode({ iss: 'https://accounts.google.com', aud: metadata.audience,
    sub: '123456789', email: metadata.serviceAccount, iat: now, exp: now + 3600 })}.${signature}`;
  const execute = vi.fn();
  const assertion = `${encode({ alg: 'RS256', typ: 'JWT', kid: metadata.keyId })}.${encode({ iss: metadata.serviceAccount,
    aud: 'https://oauth2.googleapis.com/token', target_audience: metadata.audience, iat: now, exp: now + 300 })}.${signature}`;
  const signAssertion = vi.fn().mockResolvedValue(assertion);
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id_token: token }), { status: 200 }));
  const dependencies = { signAssertion, fetch, now: () => now * 1000 };
  expect(await produceHelperOutput({ ...machineOptions, check: true }, execute, dependencies)).toEqual({ configuration_valid: true, token_acquisition_attempted: false });
  expect(signAssertion).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect((await produceHelperOutput(machineOptions, execute, dependencies)).Authorization).toBe(`Bearer ${token}`);
  expect(execute).not.toHaveBeenCalled();
  expect(signAssertion).toHaveBeenCalledTimes(1);
});

it.runIf(process.platform === 'win32')('machine failures cannot recommend personal login or leak protected output', async () => {
  const machineConfig = join(directory, 'machine.json');
  await writeFile(machineConfig, JSON.stringify({ version: 1, type: 'windows-tpm', serviceAccount: 'fixture@fixture-project.iam.gserviceaccount.com',
    keyId: 'a'.repeat(40), certificateThumbprint: 'B'.repeat(40), audience: 'https://fixture-service.run.app' }));
  const output = { write: vi.fn() }, errors = { write: vi.fn() }, execute = vi.fn();
  const signAssertion = vi.fn().mockRejectedValue(Object.assign(new Error('private-key-content'), { stderr: 'Reauthentication required. secret' }));
  expect(await main(['--env-file', options.envFile, '--machine-config', machineConfig], output, errors, execute, { signAssertion })).toBe(1);
  expect(errors.write).toHaveBeenCalledExactlyOnceWith('Cloud Run authentication helper failed; verify private configuration and the selected authentication method.\n');
  expect(output.write).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
