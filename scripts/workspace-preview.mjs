import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const script = await build({ entryPoints: ['scripts/workspace-fixture-host.mjs'], bundle: true, format: 'esm', write: false, target: 'es2022' });
const html = await readFile('dist/ui/workspace.html', 'utf8');
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/workspace') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
  else if (req.url === '/host.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(script.outputFiles[0].text); }
  else if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html><head><meta charset="utf-8"><title>Plytix fixture preview</title></head><body style="margin:0;font:13px system-ui"><p style="padding:8px;margin:0;background:#eee">Fixture preview — no live catalog access. <span id="attached"></span></p><iframe id="workspace" title="Catalog Workspace" style="display:block;width:100%;height:calc(100vh - 34px);border:0"></iframe><script type="module" src="/host.js"></script></body></html>'); }
  else { res.statusCode = 404; res.end(); }
});
server.listen(4174, '127.0.0.1', () => console.log('Fixture workspace: http://127.0.0.1:4174'));
