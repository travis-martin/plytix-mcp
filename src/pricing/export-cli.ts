#!/usr/bin/env node
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPortableExport } from './portable-export.js';

const help = `Export saved organization pricing knowledge for another AI platform.

plytix-pricing-export --input capture.json --output NEW_DIRECTORY

Reads saved, complete MCP structuredContent results; makes no network requests
and loads no credentials. Writes organization-knowledge.md and matching JSON.
The output directory must not already exist. See docs/portable-knowledge.md.
`;

try {
  const { values } = parseArgs({ options: {
    input: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
  }, strict: true, allowPositionals: false });
  if (values.help) {
    console.log(help);
  } else {
    if (!values.input || !values.output) throw new Error('arguments');
    const handle = await open(resolve(values.input), 'r');
    let input: unknown;
    try {
      if ((await handle.stat()).size > 16 * 1024 * 1024) throw new Error('size');
      const raw = await handle.readFile('utf8');
      if (Buffer.byteLength(raw, 'utf8') > 16 * 1024 * 1024) throw new Error('size');
      input = JSON.parse(raw);
    } finally { await handle.close(); }
    const result = createPortableExport(input);
    const destination = resolve(values.output);
    await mkdir(dirname(destination), { recursive: true });
    // Never overwrite a previous export or the authoritative runtime store.
    await mkdir(destination, { mode: 0o700 });
    await writeFile(join(destination, 'organization-knowledge.json'), `${JSON.stringify(result.document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await writeFile(join(destination, 'organization-knowledge.md'), result.markdown, { flag: 'wx', mode: 0o600 });
    console.log('Created organization-knowledge.md and organization-knowledge.json. This is a dated guidance snapshot, not a runtime import.');
  }
} catch {
  // Never echo input, filenames, schema errors or organization data to logs.
  console.error('Export failed. Check complete successful captures, matching organization/revisions, input size (16 MiB maximum), and a new writable output directory. Use --help for usage.');
  process.exitCode = 1;
}
