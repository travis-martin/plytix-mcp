import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateChangeRecord } from './change-record.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(readFileSync(resolve(root, '.change-record-policy.json'), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  const args = process.argv.slice(2);
  if (args[0] === '--message-file' && args.length === 2) {
    const errors = validateChangeRecord(readFileSync(resolve(args[1]), 'utf8'), policy);
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Change record matches standard v1.');
  } else if (!args.length || (args.length === 1 && args[0] === '--ci')) {
    let target = 'HEAD';
    if (process.env.GITHUB_EVENT_PATH && process.env.GITHUB_EVENT_NAME === 'pull_request') {
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      if (!/^[0-9a-f]{40}$/.test(event.pull_request?.head?.sha ?? '')) throw new Error('Pull-request head is unavailable.');
      target = event.pull_request.head.sha;
    }
    git('merge-base', '--is-ancestor', policy.baseline_commit, target);
    const commits = git('rev-list', '--reverse', `${policy.baseline_commit}..${target}`).split('\n').filter(Boolean);
    const failures = [];
    for (const id of commits) {
      const errors = validateChangeRecord(git('show', '-s', '--format=%B', id), policy);
      if (errors.length) failures.push(`${id.slice(0, 12)}:\n${errors.join('\n')}`);
    }
    if (failures.length) throw new Error(failures.join('\n\n'));
    console.log(`Validated ${commits.length} change records after the standard's baseline.`);
  } else throw new Error('Usage: node scripts/check-change-record.mjs [--message-file PATH | --ci]');
} catch (error) {
  console.error(`Change record check failed: ${error.message}`);
  console.error('See docs/change-history.md and .gitmessage. Existing historical commits must not be rewritten.');
  process.exitCode = 1;
}
