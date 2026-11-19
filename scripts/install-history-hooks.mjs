import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const get = key => { try { return git('config', '--get', key); } catch { return ''; } };
if (!existsSync(resolve(root, '.git'))) {
  console.log('Git checkout absent; hook installation is not applicable to the packaged server.');
} else {
  const comparable = path => process.platform === 'win32' ? path.toLowerCase() : path;
  if (comparable(realpathSync(git('rev-parse', '--show-toplevel'))) !== comparable(realpathSync(root))) throw new Error('Unexpected Git checkout root.');
  for (const [key, value] of [['core.hooksPath', '.githooks'], ['commit.template', '.gitmessage']]) {
    const existing = get(key);
    if (existing && existing !== value) {
      console.log(`Preserved existing ${key}; CI still validates the change-record standard. Integrate the repository hook/template with the existing configuration.`);
      continue;
    }
    git('config', '--local', key, value);
    console.log(`Configured repository ${key}.`);
  }
}
