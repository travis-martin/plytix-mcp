import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validatePlugin } from './plugin-check.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputParent = join(repo, 'build', 'plugin-artifacts');
const output = join(outputParent, 'plytix-catalog');
const source = join(repo, 'plugin', 'plytix-catalog');
await mkdir(outputParent, { recursive: true });
// Delete only our fixed generated child of this checkout's build directory.
if (relative(outputParent, output) !== 'plytix-catalog') throw new Error('Unsafe plugin output path');
try { if ((await lstat(output)).isSymbolicLink()) throw new Error('Plugin output must not be a link'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true, dereference: false });
await mkdir(join(output, 'server'), { recursive: true });
await mkdir(join(output, 'ui'), { recursive: true });
await cp(join(repo, 'dist/ui/workspace.html'), join(output, 'ui/workspace.html'));
await build({
  entryPoints: [join(repo, 'src', 'index.ts')], outfile: join(output, 'server', 'index.mjs'),
  bundle: true, platform: 'node', target: 'node22', format: 'esm', sourcemap: false,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning', legalComments: 'eof',
});
await cp(join(repo, 'LICENSE'), join(output, 'LICENSE'));
await cp(join(repo, 'docs', 'plugin.md'), join(output, 'README.md'));
const manifest = JSON.parse(await readFile(join(output, 'plugin.json'), 'utf8'));
const version = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version;
manifest.version = version;
await writeFile(join(output, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
await validatePlugin(output);
const archive = join(outputParent, `plytix-catalog-${version}.tgz`);
execFileSync('tar', ['-czf', archive, '-C', outputParent, 'plytix-catalog'], { stdio: 'pipe' });
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
async function filesAt(path, prefix = '') {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await filesAt(join(path, entry.name), name + '/'));
    else files.push(name);
  }
  return files;
}
const expected = (await filesAt(output)).map(name => 'plytix-catalog/' + name).sort();
const actual = entries.filter(name => !name.endsWith('/')).sort();
if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Plugin archive does not match validated source');
console.log(JSON.stringify({ plugin: output, archive, files: expected.length, version }));
