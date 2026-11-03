// Native Codex http_headers_helper. Do not run without --check in a terminal:
// successful normal stdout is a private credential pipe owned by the MCP host.
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const executeFile = promisify(execFile);
const SAFE_FAILURE = 'Cloud Run authentication helper failed; verify private configuration and existing gcloud sign-in.';
const ACCOUNT = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}@[a-zA-Z0-9][a-zA-Z0-9.-]{0,190}$/;
const FIELDS = ['MCP_AUTH_TOKEN', 'PLYTIX_API_KEY', 'PLYTIX_API_PASSWORD'];

export function parseHelperArgs(args, platform = process.platform) {
  try {
    const { values, tokens } = parseArgs({ args, allowPositionals: false, strict: true, tokens: true, options: {
      'env-file': { type: 'string' }, account: { type: 'string' },
      gcloud: { type: 'string' }, check: { type: 'boolean', default: false },
    } });
    const names = tokens.filter(token => token.kind === 'option').map(token => token.name);
    if (new Set(names).size !== names.length) throw new Error();
    const paths = platform === 'win32' ? path.win32 : path.posix;
    if (!values['env-file'] || !paths.isAbsolute(values['env-file']) ||
        !values.gcloud || !paths.isAbsolute(values.gcloud) ||
        !values.account || !ACCOUNT.test(values.account)) throw new Error();
    // Windows .cmd execution requires a command string; keep its only substituted
    // path/argument free of shell operators, expansions, quoting and newlines.
    if (/["&|<>^%!\r\n`]/.test(values.gcloud) || /[\r\n\0]/.test(values['env-file'])) throw new Error();
    return { envFile: values['env-file'], account: values.account, gcloud: values.gcloud, check: values.check };
  } catch { throw new Error(SAFE_FAILURE); }
}

export async function readHeaderConfiguration(options) {
  try {
    const contents = await readFile(options.envFile, 'utf8');
    if (Buffer.byteLength(contents) > 64 * 1024) throw new Error();
    const values = parse(contents);
    for (const name of FIELDS) {
      const value = values[name];
      if (typeof value !== 'string' || !value.length || value.length > 4096 || /[^\x20-\x7e]/.test(value)) throw new Error();
    }
    if (values.MCP_AUTH_TOKEN.length < 32) throw new Error();
    if (!(await stat(options.gcloud)).isFile()) throw new Error();
    return {
      'X-MCP-Token': values.MCP_AUTH_TOKEN,
      'X-Plytix-API-Key': values.PLYTIX_API_KEY,
      'X-Plytix-API-Password': values.PLYTIX_API_PASSWORD,
    };
  } catch { throw new Error(SAFE_FAILURE); }
}

export function gcloudInvocation(options, platform = process.platform, environment = process.env) {
  const args = ['auth', 'print-identity-token', `--account=${options.account}`, '--quiet'];
  if (platform === 'win32' && /\.ps1$/i.test(options.gcloud)) {
    return {
      executable: path.win32.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-NonInteractive', '-File', options.gcloud, ...args], windowsVerbatimArguments: false,
    };
  }
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(options.gcloud)) {
    const command = `""${options.gcloud}" ${args.join(' ')}"`;
    return {
      executable: path.win32.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
      args: ['/d', '/s', '/c', command], windowsVerbatimArguments: true,
    };
  }
  return { executable: options.gcloud, args, windowsVerbatimArguments: false };
}

export async function produceHelperOutput(options, execute = executeFile) {
  const headers = await readHeaderConfiguration(options);
  if (options.check) return { configuration_valid: true, token_acquisition_attempted: false };
  try {
    const invocation = gcloudInvocation(options);
    const { stdout } = await execute(invocation.executable, invocation.args, {
      encoding: 'utf8', timeout: 7000, maxBuffer: 64 * 1024, windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const token = stdout.trim();
    if (token.length > 16000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    return { Authorization: `Bearer ${token}`, ...headers };
  } catch { throw new Error(SAFE_FAILURE); }
}

export async function main(args, output = process.stdout, errors = process.stderr) {
  try {
    const result = await produceHelperOutput(parseHelperArgs(args));
    output.write(JSON.stringify(result) + '\n');
    return 0;
  } catch {
    // Never include subprocess stderr, stdout, arguments or parsed config values.
    if (args.includes('--check')) output.write(JSON.stringify({ configuration_valid: false, token_acquisition_attempted: false }) + '\n');
    else errors.write(SAFE_FAILURE + '\n');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
