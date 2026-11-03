import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function validatePlugin(root) {
  const files = [];
  async function walk(path) {
    for (const entry of await readdir(path)) {
      const absolute = join(path, entry), stat = await lstat(absolute);
      assert(!stat.isSymbolicLink(), 'Plugin cannot contain symlinks');
      const name = relative(root, absolute).replaceAll('\\', '/');
      assert(!/(^|\/)(node_modules|\.git|\.env(?:\..*)?|\.local|data)(\/|$)/.test(name), 'Private or dependency files in package');
      if (stat.isDirectory()) await walk(absolute);
      else { assert(stat.isFile()); files.push(name); }
    }
  }
  await walk(root);
  const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'plytix-catalog');
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  for (const legacy of ['skills', 'mcpServers', 'apps', 'interface']) assert(!(legacy in manifest));
  const presentation = manifest.extensions['com.openai'].interface;
  assert(presentation.shortDescription.length <= 30 && presentation.shortDescription.trim());
  assert.equal(presentation.category, 'Business & Operations');
  assert(Array.isArray(presentation.capabilities));
  assert(Array.isArray(presentation.defaultPrompt) && presentation.defaultPrompt.length <= 3);
  const mcp = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8'));
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.deepEqual(Object.keys(mcp.mcpServers), ['plytix-catalog']);
  const server = mcp.mcpServers['plytix-catalog'];
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, 'node');
  assert.equal(server.cwd, '${PLUGIN_ROOT}');
  assert.deepEqual(server.args, ['${PLUGIN_ROOT}/server/index.mjs']);
  assert(!server.env, 'Credentials and account defaults do not belong in the manifest');
  assert(files.includes('server/index.mjs'), 'Built entry point missing');
  assert(files.includes('ui/workspace.html'), 'Built workspace missing');
  assert(files.includes('LICENSE'));
  const license = await readFile(join(root, 'LICENSE'), 'utf8');
  assert(license.includes('Permission is hereby granted') && license.includes('Copyright'));
  const skills = files.filter(path => /^skills\/[^/]+\/SKILL\.md$/.test(path));
  assert.equal(skills.length, 4);
  const names = new Set();
  for (const path of skills) {
    const text = await readFile(join(root, path), 'utf8');
    assert(Buffer.byteLength(text) <= 1024 * 1024);
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    assert(frontmatter, 'Skill YAML frontmatter missing');
    // These authored frontmatters use JSON, a YAML 1.2 subset. Parse as data.
    const data = JSON.parse(frontmatter[1]);
    assert.equal(data.name, path.split('/')[1]);
    assert(typeof data.description === 'string' && data.description.trim());
    assert(!names.has(data.name)); names.add(data.name);
  }
  const allowed = new Set(['plugin.json', 'mcp.json', 'server/index.mjs', 'ui/workspace.html', 'LICENSE', 'README.md', ...skills]);
  assert.deepEqual(files.filter(name => !allowed.has(name)), [], 'Unexpected archive files');
  return { files: files.length, skills: skills.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(await validatePlugin(resolve(process.argv[2] ?? join(repo, 'build/plugin-artifacts/plytix-catalog')))));
}
