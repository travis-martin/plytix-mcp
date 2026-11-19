#!/usr/bin/env node
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { prepareHistoryRollback } from './history-rollback.js';

const help = `Prepare an offline reviewed rollback candidate without changing any runtime store.

plytix-pricing-history --current organization-knowledge.json --history history-response.json --change-id ARCHIVE_SHA256 --review review-metadata.json --output NEW_DIRECTORY

Capture pricing_history_get with limit=1, include_snapshots=true and the chosen
committed cursor. Supply a fresh complete portable export from the same workspace.
The review JSON requires sources and reason; change_id and reviewer are optional.
Output rollback-candidate.json and rollback-review.md. Review the candidate and use
the existing plytix-pricing-import prepare/preflight and host-approved save tools.
No credentials, network calls, product updates or runtime writes are performed.
`;
async function readJson(path: string | undefined) {
  if (!path) throw new Error('Missing argument');
  const handle = await open(resolve(path), 'r');
  try {
    if ((await handle.stat()).size > 16 * 1024 * 1024) throw new Error('Input too large');
    const data = await handle.readFile('utf8');
    if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw new Error('Input too large');
    return JSON.parse(data) as unknown;
  } finally { await handle.close(); }
}
try {
  const { values } = parseArgs({ options: { current: { type: 'string' }, history: { type: 'string' }, 'change-id': { type: 'string' },
    review: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } }, strict: true, allowPositionals: false });
  if (values.help) console.log(help);
  else {
    if (!values.output || !values['change-id']) throw new Error('Missing argument');
    const result = prepareHistoryRollback({ current: await readJson(values.current), history: await readJson(values.history),
      change_id: values['change-id'], review: await readJson(values.review) });
    const destination = resolve(values.output);
    await mkdir(dirname(destination), { recursive: true }); await mkdir(destination, { mode: 0o700 });
    await writeFile(join(destination, 'rollback-candidate.json'), `${JSON.stringify(result.candidate, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await writeFile(join(destination, 'rollback-review.md'), result.markdown, { flag: 'wx', mode: 0o600 });
    console.log('Created offline rollback proposal. No runtime write or approval occurred.');
  }
} catch {
  console.error('Rollback proposal failed. Verify the committed snapshot checksum, matching current export revisions/workspace, structured review metadata, input sizes and new output directory. Use --help.');
  process.exitCode = 1;
}
