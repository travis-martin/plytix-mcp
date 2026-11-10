import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['src/ui/workspace.ts'], bundle: true, write: false, format: 'iife', target: 'es2021', minify: true });
const shell = await readFile('src/ui/workspace.html', 'utf8');
const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await mkdir('dist/ui', { recursive: true });
await writeFile('dist/ui/workspace.html', shell.replace('<!-- APP_SCRIPT -->', () => `<script>${script}</script>`));
await build({ entryPoints: ['scripts/review-panel-host.mjs'], bundle: true, outfile: 'dist/ui/review-panel-host.js', format: 'esm', target: 'es2022', minify: true });
