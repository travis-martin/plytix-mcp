import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const windows = process.platform === 'win32';
const executable = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const script = resolve('scripts/windows-tpm-provision.ps1');
let directory: string;

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'plytix-tpm-provision-fixture-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function rejectedInvocation(parameters: Record<string, unknown>, mockedCreationAttempt = false) {
  const flag = join(directory, 'unexpected-credential-creation.txt');
  // Mock the mutating cmdlet even for rejection tests. A validation regression
  // must never create an actual credential in the Windows certificate store.
  const code = `
    function global:New-SelfSignedCertificate {
      param([DateTime]$NotBefore, [DateTime]$NotAfter)
      $captured = @{ notBeforeKind = [string]$NotBefore.Kind; notAfterKind = [string]$NotAfter.Kind; notBeforeUtc = $NotBefore.ToUniversalTime().ToString('o'); notAfterUtc = $NotAfter.ToUniversalTime().ToString('o') }
      [System.IO.File]::WriteAllText($env:PLYTIX_CREATION_FLAG, ($captured | ConvertTo-Json -Compress))
      throw 'Fixture refuses real credential creation'
    }
    $parameters = @{}
    ($env:PLYTIX_PROVISION_PARAMETERS | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $parameters[$_.Name] = $_.Value }
    & $env:PLYTIX_PROVISION_SCRIPT @parameters
  `;
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, PLYTIX_PROVISION_SCRIPT: script, PLYTIX_PROVISION_PARAMETERS: JSON.stringify(parameters), PLYTIX_CREATION_FLAG: flag },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  const lines = result.stderr.trim().split(/\r?\n/);
  expect(lines, result.stderr).toHaveLength(2);
  expect(lines[0]).toBe('TPM provisioning failed. No private key was exported. Preserve any output directory and inspect provisioning-state.jsonl and the CurrentUser certificate store before retrying; partial state may exist.');
  const diagnostic = JSON.parse(lines[1]);
  expect(Object.keys(diagnostic).sort()).toEqual(['category', 'hresults', 'stage']);
  expect(diagnostic.stage).toMatch(/^(validate-options|reserve-output|create-certificate|inspect-certificate)$/);
  expect(diagnostic.category).toMatch(/^[A-Za-z]+$/);
  expect(diagnostic.hresults.length).toBeGreaterThan(0);
  for (const code of diagnostic.hresults) expect(code).toMatch(/^0x[0-9A-F]{8}$/);
  expect(result.stderr).not.toContain('secret-fixture-invalid');
  expect(result.stderr).not.toContain('Fixture refuses real credential creation');
  expect(existsSync(flag), result.stderr).toBe(mockedCreationAttempt);
  return result;
}

it.runIf(windows)('parses the native provisioning script without executing it', () => {
  const code = `$tokens = $null; $parseErrors = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile($env:PLYTIX_PROVISION_SCRIPT, [ref]$tokens, [ref]$parseErrors); [Console]::Out.WriteLine($parseErrors.Count); if ($parseErrors.Count -ne 0) { exit 1 }`;
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, PLYTIX_PROVISION_SCRIPT: script },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('0');
  expect(result.stderr).toBe('');
}, 20000);

it.runIf(windows)('requires a new absolute output path before invoking any credential creation', async () => {
  const sentinel = join(directory, 'preserve.txt');
  await writeFile(sentinel, 'preserve existing directory');
  rejectedInvocation({ OutputDirectory: directory });
  expect(await readFile(sentinel, 'utf8')).toBe('preserve existing directory');
  expect(existsSync(join(directory, 'provisioning-state.jsonl'))).toBe(false);
  rejectedInvocation({ OutputDirectory: 'relative-fixture-output' });
}, 30000);

it.runIf(windows)('rejects unsupported lifetimes and missing parents without reserving output', () => {
  const output = join(directory, 'must-not-exist');
  rejectedInvocation({ OutputDirectory: output, ValidityYears: 0 });
  rejectedInvocation({ OutputDirectory: output, ValidityYears: 6 });
  expect(existsSync(output)).toBe(false);
  rejectedInvocation({ OutputDirectory: join(directory, 'missing-parent', 'output') });
  expect(existsSync(join(directory, 'missing-parent'))).toBe(false);
}, 45000);

it.runIf(windows)('inspection rejects a malformed thumbprint without writing or provisioning', () => {
  rejectedInvocation({ InspectOnly: true, CertificateThumbprint: 'secret-fixture-invalid' });
}, 20000);

it.runIf(windows)('preserves a reserved recovery record and rejects a retry after a mocked creation failure', async () => {
  const output = join(directory, 'interrupted-provisioning');
  rejectedInvocation({ OutputDirectory: output }, true);
  const journalPath = join(output, 'provisioning-state.jsonl');
  const initial = await readFile(journalPath, 'utf8');
  const [record, failure] = initial.trim().split(/\r?\n/).map(line => JSON.parse(line));
  expect(record).toMatchObject({ version: 1, phase: 'reserved', certificateStore: 'CurrentUser/My' });
  expect(record.keyContainer).toMatch(/^plytix-mcp-[a-f0-9]{32}$/);
  expect(failure).toMatchObject({ version: 1, phase: 'failed', diagnostic: { stage: 'create-certificate' } });
  const captured = JSON.parse(await readFile(join(directory, 'unexpected-credential-creation.txt'), 'utf8'));
  expect(captured).toMatchObject({ notBeforeKind: 'Local', notAfterKind: 'Local' });
  expect(Date.parse(captured.notAfterUtc)).toBe(Date.parse(record.requestedNotAfter));
  expect(Math.abs(Date.parse(captured.notBeforeUtc) - (Date.parse(record.createdAt) - 300000))).toBeLessThan(1000);
  expect(existsSync(join(output, 'certificate.pem'))).toBe(false);
  expect(existsSync(join(output, 'identity-public.json'))).toBe(false);
  await rm(join(directory, 'unexpected-credential-creation.txt'));
  rejectedInvocation({ OutputDirectory: output });
  expect(await readFile(journalPath, 'utf8')).toBe(initial);
}, 30000);
