import { afterEach, expect, it } from 'vitest';
import { mkdtemp, cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildAuthHelper } from '../../scripts/build-auth-helper.mjs';

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });

it('builds a movable immutable helper that runs without checkout dependencies or credential files', async () => {
  const artifact = await buildAuthHelper();
  const repeated = await buildAuthHelper();
  expect(repeated.digest).toBe(artifact.digest);
  expect((await readdir(artifact.directory)).sort()).toEqual(['LICENSE', 'cloud-run-headers.mjs', 'manifest.json', 'windows-tpm-sign.ps1']);
  for (const [name, checksum] of Object.entries(artifact.files)) {
    expect(createHash('sha256').update(await readFile(join(artifact.directory, name))).digest('hex')).toBe(checksum);
  }
  const directory = await mkdtemp(join(tmpdir(), 'standalone-auth-fixture-')); temporary.push(directory);
  await cp(artifact.directory, join(directory, 'runtime'), { recursive: true });
  const envFile = join(directory, 'fixture.env');
  await writeFile(envFile, 'MCP_AUTH_TOKEN=fixture-123456789012345678901234567890\nPLYTIX_API_KEY=fixture-key\nPLYTIX_API_PASSWORD=fixture-password\n');
  const common = [join(directory, 'runtime/cloud-run-headers.mjs'), '--env-file', envFile];
  const result = execFileSync(process.execPath, [...common, '--account', 'fixture@example.test', '--gcloud', process.execPath, '--check'], {
    cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  expect(JSON.parse(result)).toEqual({ configuration_valid: true, token_acquisition_attempted: false });
  expect(result).not.toContain('fixture-key');
  if (process.platform === 'win32') {
    const machine = join(directory, 'machine.json');
    await writeFile(machine, JSON.stringify({ version: 1, type: 'windows-tpm', serviceAccount: 'fixture@fixture-project.iam.gserviceaccount.com',
      keyId: 'a'.repeat(40), certificateThumbprint: 'B'.repeat(40), audience: 'https://fixture-service.run.app' }));
    const status = execFileSync(process.execPath, [...common, '--machine-config', machine, '--check'], { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(JSON.parse(status)).toEqual({ configuration_valid: true, token_acquisition_attempted: false });
  }
}, 20000);
