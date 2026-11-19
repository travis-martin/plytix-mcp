import { expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseReviewPanelOptions } from '../../scripts/review-panel.mjs';

const envFile = join(tmpdir(), 'fixture-private.env');
const machineConfig = join(tmpdir(), 'fixture-machine-auth.json');
const base = ['--url', 'https://fixture.example.test/mcp', '--review', 'fixture-review', '--env-file', envFile];

it('preserves legacy helper options for the review-panel launcher', () => {
  const parsed = parseReviewPanelOptions([...base, '--account', 'fixture@example.test', '--gcloud', process.execPath]);
  expect(parsed.authentication).toEqual({ envFile, account: 'fixture@example.test', gcloud: process.execPath, check: false });
  expect(parsed.url.href).toBe('https://fixture.example.test/mcp');
  expect(parsed.reviewId).toBe('fixture-review');
  expect(parsed.port).toBe(0);
});

it('forwards machine authentication without a personal account or gcloud dependency', () => {
  const parsed = parseReviewPanelOptions([...base, '--machine-config', machineConfig, '--port', '43121']);
  expect(parsed.authentication).toEqual({ envFile, machineConfig, check: false });
  expect(parsed.port).toBe(43121);
});

it.each([
  ['--machine-config', machineConfig, '--account', 'fixture@example.test'],
  ['--machine-config', machineConfig, '--gcloud', process.execPath],
  ['--machine-config', machineConfig, '--machine-config', machineConfig],
  ['--machine-config', 'relative.json'],
  ['--machine-config', machineConfig, '--port', '65536'],
  ['--machine-config', machineConfig, '--port', '1.5'],
  ['--machine-config', machineConfig, '--url', 'https://user:PRIVATE_SENTINEL@example.test/mcp'],
  ['--machine-config', machineConfig, '--unknown', 'PRIVATE_SENTINEL'],
])('rejects unsafe or ambiguous review-panel configuration without reflecting it (%j)', args => {
  expect(() => parseReviewPanelOptions([...base, ...args])).toThrow(/^Review panel could not start\. Check the review ID, configured service, built UI and authentication configuration\. Credentials are never printed\.$/);
});
