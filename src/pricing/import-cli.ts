#!/usr/bin/env node
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createImportCandidate, prepareReviewedImport, preflightReviewedImport, renderImportReview } from './reviewed-import.js';

const help = `Prepare reviewed organization guidance imports without changing a runtime store.

plytix-pricing-import --mode draft --baseline export.json --output NEW_DIRECTORY
plytix-pricing-import --mode prepare --baseline export.json --candidate candidate.json --capture fresh-capture.json --output NEW_DIRECTORY
plytix-pricing-import --mode preflight --review reviewed-import.json --reviewed-digest SHA256 --capture fresh-capture.json --output NEW_DIRECTORY

Draft produces editable business fields bound to the verified export checksum.
Prepare produces exact existing-tool arguments and a before/after review.
Preflight verifies the reviewed digest against fresh complete source captures.
It only emits calls to request through the existing host-approved MCP workflow;
it does not execute tools, load credentials, change approvals or write stores.
Stop after any tool failure or uncertain result, recapture, and re-review.
Every output directory must be new. See docs/portable-knowledge.md.
`;
async function readJson(path: string | undefined): Promise<unknown> {
  if (!path) throw new Error('arguments');
  const handle = await open(resolve(path), 'r');
  try {
    if ((await handle.stat()).size > 16 * 1024 * 1024) throw new Error('size');
    const raw = await handle.readFile('utf8');
    if (Buffer.byteLength(raw, 'utf8') > 16 * 1024 * 1024) throw new Error('size');
    return JSON.parse(raw);
  } finally { await handle.close(); }
}
try {
  const { values } = parseArgs({ options: {
    mode: { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' }, capture: { type: 'string' },
    review: { type: 'string' }, 'reviewed-digest': { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
  }, strict: true, allowPositionals: false });
  if (values.help) console.log(help);
  else {
    if (!values.output) throw new Error('arguments');
    const files: Array<[string, string]> = [];
    if (values.mode === 'draft') files.push(['import-candidate.json', JSON.stringify(createImportCandidate(await readJson(values.baseline)), null, 2)]);
    else if (values.mode === 'prepare') {
      const review = prepareReviewedImport({ baseline: await readJson(values.baseline), candidate: await readJson(values.candidate), capture: await readJson(values.capture) });
      files.push(['reviewed-import.json', JSON.stringify(review, null, 2)], ['reviewed-import.md', renderImportReview(review)]);
    } else if (values.mode === 'preflight') {
      if (!values['reviewed-digest']) throw new Error('arguments');
      const result = preflightReviewedImport({ review: await readJson(values.review), reviewed_digest: values['reviewed-digest'], capture: await readJson(values.capture) });
      files.push(['preflight-tool-calls.json', JSON.stringify(result, null, 2)]);
    } else throw new Error('arguments');
    const destination = resolve(values.output);
    await mkdir(dirname(destination), { recursive: true });
    await mkdir(destination, { mode: 0o700 });
    for (const [name, content] of files) await writeFile(join(destination, name), `${content}\n`, { flag: 'wx', mode: 0o600 });
    console.log('Created offline import review files. No runtime write or tool execution occurred; existing host approval remains required.');
  }
} catch {
  console.error('Import review failed. Check valid checksums, complete fresh captures, matching baseline revisions, explicit decisions/removals, input size and a new output directory. Use --help for usage.');
  process.exitCode = 1;
}
