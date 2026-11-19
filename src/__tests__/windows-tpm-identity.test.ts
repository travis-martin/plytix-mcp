import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMachineConfiguration, getMachineIdentityToken } from '../../scripts/windows-tpm-identity.mjs';

const fixedTime = 1_800_000_000;
const endpoint = 'https://oauth2.googleapis.com/token';
const machine = {
  version: 1, type: 'windows-tpm', serviceAccount: 'fixture-caller@fixture-project.iam.gserviceaccount.com',
  keyId: 'a'.repeat(40), certificateThumbprint: 'B'.repeat(40), audience: 'https://fixture-service.run.app',
};
const jwt = (claims: object, header: object = { alg: 'RS256', typ: 'JWT' }) => [
  Buffer.from(JSON.stringify(header)).toString('base64url'),
  Buffer.from(JSON.stringify(claims)).toString('base64url'), Buffer.alloc(256, 7).toString('base64url'),
].join('.');
const identity = (overrides = {}) => jwt({
  iss: 'https://accounts.google.com', aud: machine.audience, sub: '123456789012345678901',
  iat: fixedTime, exp: fixedTime + 3600, email: machine.serviceAccount, email_verified: true, ...overrides,
});
const sign = (config: typeof machine, { issuedAt, expiresAt }: { issuedAt: number; expiresAt: number }) => Promise.resolve(jwt({
  iss: config.serviceAccount, aud: endpoint, target_audience: config.audience, iat: issuedAt, exp: expiresAt,
}, { alg: 'RS256', typ: 'JWT', kid: config.keyId }));
const dependencies = (extra = {}) => ({
  platform: 'win32', now: () => fixedTime * 1000, signAssertion: vi.fn(sign),
  fetch: vi.fn().mockImplementation(async () => Response.json({ id_token: identity() })), ...extra,
});
let directory: string, configFile: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tpm-identity-fixture-'));
  configFile = join(directory, 'machine.json');
  await writeFile(configFile, JSON.stringify(machine));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

it('reads only strict public machine metadata without acquiring credentials', async () => {
  const result = await readMachineConfiguration(configFile, { platform: 'win32' });
  expect(result).toEqual(machine);
  expect(Object.isFrozen(result)).toBe(true);
});

it.each([
  { private_key: 'PRIVATE_FIXTURE_SECRET' }, { token_uri: 'https://attacker.test/token' },
  { version: 2 }, { type: 'authorized_user' }, { serviceAccount: 'human@example.test' },
  { keyId: 'short' }, { certificateThumbprint: '../escape' },
  { audience: 'https://fixture-service.run.app/mcp' }, { audience: 'https://fixture-service.run.app/' },
  { audience: 'https://user:pass@fixture-service.run.app' }, { audience: 'http://fixture-service.run.app' },
  { audience: 'https://fixture-service.run.app?secret=x' }, { audience: 'https://fixture-service.run.app#x' },
])('fails closed for unsupported or ambiguous metadata (%j)', async override => {
  await writeFile(configFile, JSON.stringify({ ...machine, ...override }));
  await expect(readMachineConfiguration(configFile, { platform: 'win32' })).rejects.toThrow(/^Windows TPM authentication failed;/);
});

it('rejects missing, relative, oversized and non-Windows configuration without exposing values', async () => {
  await expect(readMachineConfiguration('PRIVATE_FIXTURE_SECRET.json', { platform: 'win32' })).rejects.toThrow(/^Windows TPM authentication failed;/);
  await expect(readMachineConfiguration(configFile, { platform: 'linux' })).rejects.toThrow(/^Windows TPM authentication failed;/);
  await writeFile(configFile, 'PRIVATE_FIXTURE_SECRET'.repeat(2000));
  await expect(readMachineConfiguration(configFile, { platform: 'win32' })).rejects.toThrow(/^Windows TPM authentication failed;/);
  await writeFile(configFile, JSON.stringify({ ...machine, audience: undefined }));
  await expect(readMachineConfiguration(configFile, { platform: 'win32' })).rejects.toThrow(/^Windows TPM authentication failed;/);
});

it('exchanges a scoped, short-lived TPM assertion only with the fixed Google endpoint', async () => {
  const deps = dependencies();
  expect(await getMachineIdentityToken(machine, deps)).toBe(identity());
  expect(deps.signAssertion).toHaveBeenCalledExactlyOnceWith(machine, {
    issuedAt: fixedTime, expiresAt: fixedTime + 300, signal: expect.any(AbortSignal),
  });
  expect(deps.fetch).toHaveBeenCalledOnce();
  const [url, options] = deps.fetch.mock.calls[0];
  expect(url).toBe(endpoint);
  expect(options).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal) });
  const form = new URLSearchParams(options.body);
  expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
  const claims = JSON.parse(Buffer.from(form.get('assertion')!.split('.')[1], 'base64url').toString());
  expect(claims).toEqual({ iss: machine.serviceAccount, aud: endpoint, target_audience: machine.audience, iat: fixedTime, exp: fixedTime + 300 });
  expect(claims).not.toHaveProperty('scope');
  expect(claims).not.toHaveProperty('sub');
});

it('does not silently reuse credentials between acquisitions', async () => {
  const deps = dependencies();
  await getMachineIdentityToken(machine, deps);
  await getMachineIdentityToken(machine, deps);
  expect(deps.signAssertion).toHaveBeenCalledTimes(2);
  expect(deps.fetch).toHaveBeenCalledTimes(2);
});

it('rejects a signer that changes the service identity or audience before making a request', async () => {
  const deps = dependencies({ signAssertion: vi.fn(() => sign({ ...machine, audience: 'https://attacker.test' }, { issuedAt: fixedTime, expiresAt: fixedTime + 300 })) });
  await expect(getMachineIdentityToken(machine, deps)).rejects.toThrow(/^Windows TPM authentication failed;/);
  expect(deps.fetch).not.toHaveBeenCalled();
});

it.each([
  { aud: 'https://different-service.run.app' }, { iss: 'https://attacker.test' },
  { sub: '' }, { sub: 'person@example.test' }, { sub: undefined },
  { email: 'different@fixture-project.iam.gserviceaccount.com' }, { email_verified: false },
  { exp: fixedTime + 5 }, { exp: fixedTime + 7200 }, { exp: fixedTime - 1 },
  { iat: fixedTime + 120 }, { iat: 'invalid' },
])('rejects a returned identity token with invalid claims (%j)', async claims => {
  await expect(getMachineIdentityToken(machine, dependencies({ fetch: vi.fn().mockResolvedValue(Response.json({ id_token: identity(claims) })) }))).rejects.toThrow(/^Windows TPM authentication failed;/);
});

it.each(['PRIVATE_FIXTURE_SECRET', 'one.two.three', '', 'x'.repeat(17000)])('rejects malformed returned tokens without reflecting them', async idToken => {
  await expect(getMachineIdentityToken(machine, dependencies({ fetch: vi.fn().mockResolvedValue(Response.json({ id_token: idToken })) }))).rejects.toThrow(/^Windows TPM authentication failed; verify the machine credential configuration and certificate\.$/);
});

it.each([400, 401, 403, 500])('suppresses private error responses (%s)', async status => {
  const fetch = vi.fn().mockResolvedValue(new Response('PRIVATE_FIXTURE_SECRET', { status }));
  await expect(getMachineIdentityToken(machine, dependencies({ fetch }))).rejects.toThrow(/^Windows TPM authentication failed; verify the machine credential configuration and certificate\.$/);
});

it('bounds response bodies even when their content length is absent or misleading', async () => {
  for (const headers of [{}, { 'Content-Length': '1' }, { 'Content-Length': '999999999' }]) {
    await expect(getMachineIdentityToken(machine, dependencies({ fetch: vi.fn().mockResolvedValue(new Response('X'.repeat(33000), { headers })) }))).rejects.toThrow(/^Windows TPM authentication failed;/);
  }
});

it('sanitizes signer failures and does not attempt OAuth or another credential source', async () => {
  const deps = dependencies({ signAssertion: vi.fn().mockRejectedValue(new Error('PRIVATE_FIXTURE_SECRET')) });
  await expect(getMachineIdentityToken(machine, deps)).rejects.toThrow(/^Windows TPM authentication failed; verify the machine credential configuration and certificate\.$/);
  expect(deps.fetch).not.toHaveBeenCalled();
});

it('enforces one total acquisition deadline even when the signer ignores cancellation', async () => {
  vi.useFakeTimers();
  const deps = dependencies({ signAssertion: vi.fn(() => new Promise(() => {})), timeoutMs: 70 });
  const result = getMachineIdentityToken(machine, deps);
  const rejection = expect(result).rejects.toThrow(/^Windows TPM authentication failed;/);
  await vi.advanceTimersByTimeAsync(70);
  await rejection;
  expect(deps.signAssertion.mock.calls[0][1].signal.aborted).toBe(true);
  expect(deps.fetch).not.toHaveBeenCalled();
});

it('shares the acquisition deadline across signing and an unresponsive HTTP exchange', async () => {
  vi.useFakeTimers();
  const deps = dependencies({ fetch: vi.fn(() => new Promise(() => {})), timeoutMs: 70 });
  const result = getMachineIdentityToken(machine, deps);
  const rejection = expect(result).rejects.toThrow(/^Windows TPM authentication failed;/);
  await vi.advanceTimersByTimeAsync(70);
  await rejection;
  expect(deps.fetch).toHaveBeenCalledOnce();
  expect(deps.fetch.mock.calls[0][1].signal.aborted).toBe(true);
});

it('never permits a caller to extend the helper deadline beyond seven seconds', async () => {
  const deps = dependencies({ timeoutMs: 10000 });
  await expect(getMachineIdentityToken(machine, deps)).rejects.toThrow(/^Windows TPM authentication failed;/);
  expect(deps.signAssertion).not.toHaveBeenCalled();
  expect(deps.fetch).not.toHaveBeenCalled();
});
