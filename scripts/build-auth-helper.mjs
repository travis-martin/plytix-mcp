import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function buildAuthHelper() {
  const built = await build({
    entryPoints: [join(repo, 'scripts/cloud-run-headers.mjs')], outfile: 'cloud-run-headers.mjs',
    bundle: true, write: false, platform: 'node', target: 'node22', format: 'esm',
    sourcemap: false, legalComments: 'eof', logLevel: 'warning',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  });
  assert.equal(built.outputFiles.length, 1);
  const files = {
    'cloud-run-headers.mjs': Buffer.from(built.outputFiles[0].contents),
    'windows-tpm-sign.ps1': await readFile(join(repo, 'scripts/windows-tpm-sign.ps1')),
    LICENSE: await readFile(join(repo, 'LICENSE')),
  };
  const checksums = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)]));
  const digest = sha256(JSON.stringify(checksums));
  const parent = join(repo, 'build/auth-helper'), directory = join(parent, digest);
  for (const candidate of [join(repo, 'build'), parent, directory]) {
    try { assert(!(await lstat(candidate)).isSymbolicLink(), 'Auth artifact path cannot be a link'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(directory, { recursive: true });
  const manifest = { version: 1, digest, files: checksums };
  const artifact = { ...files, 'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n') };
  for (const [name, bytes] of Object.entries(artifact)) {
    const target = join(directory, name);
    try { await writeFile(target, bytes, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assert((await readFile(target)).equals(bytes), 'Existing immutable auth artifact differs');
    }
  }
  return { directory, entry: join(directory, 'cloud-run-headers.mjs'), ...manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildAuthHelper()));
}
