// Machine authentication metadata contains no private key. The TPM signs locally;
// assertions and Google ID tokens remain in private process pipes and memory.
import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAILURE = 'Windows TPM authentication failed; verify the machine credential configuration and certificate.';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const MAX_METADATA = 16 * 1024;
const MAX_RESPONSE = 32 * 1024;
const MAX_TOKEN = 16 * 1024;
const CONFIG_FIELDS = ['version', 'type', 'serviceAccount', 'keyId', 'certificateThumbprint', 'audience'];
const ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const HEX_ID = /^[a-fA-F0-9]{40}$/;
const signerPath = fileURLToPath(new URL('./windows-tpm-sign.ps1', import.meta.url));

function failure() { return new Error(FAILURE); }

function validateConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== CONFIG_FIELDS.length ||
      !Object.keys(value).every(key => CONFIG_FIELDS.includes(key)) ||
      value.version !== 1 || value.type !== 'windows-tpm' ||
      typeof value.serviceAccount !== 'string' || !ACCOUNT.test(value.serviceAccount) ||
      typeof value.keyId !== 'string' || !HEX_ID.test(value.keyId) ||
      typeof value.certificateThumbprint !== 'string' || !HEX_ID.test(value.certificateThumbprint) ||
      typeof value.audience !== 'string' || value.audience.length > 2048) throw failure();
  const audience = new URL(value.audience);
  if (audience.protocol !== 'https:' || audience.origin !== value.audience ||
      audience.username || audience.password || audience.search || audience.hash) throw failure();
  return Object.freeze({ ...value });
}

export async function readMachineConfiguration(configPath, { platform = process.platform } = {}) {
  let file;
  try {
    if (platform !== 'win32' || typeof configPath !== 'string' ||
        !path.isAbsolute(configPath) || /[\r\n\0]/.test(configPath)) throw failure();
    file = await open(configPath, 'r');
    if (!(await file.stat()).isFile()) throw failure();
    const bytes = Buffer.alloc(MAX_METADATA + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_METADATA) throw failure();
    return validateConfiguration(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
  } catch { throw failure(); }
  finally { await file?.close().catch(() => {}); }
}

function decodeJwt(token) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw failure();
  const [headerPart, claimsPart, signature] = token.split('.');
  const decode = part => {
    const bytes = Buffer.from(part, 'base64url');
    if (bytes.toString('base64url') !== part) throw failure();
    return JSON.parse(bytes.toString('utf8'));
  };
  const header = decode(headerPart), claims = decode(claimsPart);
  const signatureBytes = Buffer.from(signature, 'base64url');
  if (!header || typeof header !== 'object' || header.alg !== 'RS256' ||
      !claims || typeof claims !== 'object' || Array.isArray(claims) ||
      signatureBytes.length < 256 || signatureBytes.toString('base64url') !== signature) throw failure();
  return { header, claims };
}

function validateAssertion(assertion, config, issuedAt, expiresAt) {
  const { header, claims } = decodeJwt(assertion);
  if (header.typ !== 'JWT' || header.kid !== config.keyId ||
      claims.iss !== config.serviceAccount || claims.aud !== TOKEN_ENDPOINT ||
      claims.target_audience !== config.audience || claims.iat !== issuedAt ||
      claims.exp !== expiresAt || Object.keys(claims).length !== 5) throw failure();
}

// No general-purpose arbitrary signing API: the child accepts only the six
// machine fields and a bounded timestamp pair, then constructs the JWT itself.
function signWithWindowsTpm(config, { issuedAt, expiresAt, signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(failure()); return; }
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-File', signerPath], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal,
    });
    let stdout = '', outputBytes = 0, stderrBytes = 0, invalid = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_TOKEN) { invalid = true; child.kill(); }
      else stdout += chunk;
    });
    // Never retain, interpolate, or report subprocess diagnostic text.
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_RESPONSE) { invalid = true; child.kill(); }
    });
    child.on('error', () => reject(failure()));
    child.stdin.on('error', () => { invalid = true; child.kill(); reject(failure()); });
    child.on('close', code => {
      if (invalid || code !== 0 || signal.aborted) reject(failure());
      else resolve(stdout.trim());
    });
    child.stdin.end(JSON.stringify({ ...config, issuedAt, expiresAt }));
  });
}

async function readBoundedResponse(response) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE)) throw failure();
  if (!response.body) throw failure();
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) throw failure();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function getMachineIdentityToken(config, dependencies = {}) {
  const { signAssertion = signWithWindowsTpm, fetch: fetchImpl = globalThis.fetch,
    now = Date.now, timeoutMs = 7000, platform = process.platform } = dependencies;
  const controller = new AbortController();
  let timer;
  try {
    config = validateConfiguration(config);
    if (platform !== 'win32' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 7000) throw failure();
    const operation = async () => {
      const issuedAt = Math.floor(now() / 1000), expiresAt = issuedAt + 300;
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw failure();
      const assertion = await signAssertion(config, { issuedAt, expiresAt, signal: controller.signal });
      validateAssertion(assertion, config, issuedAt, expiresAt);
      if (controller.signal.aborted) throw failure();
      const response = await fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      });
      if (!response.ok || response.redirected || (response.url && response.url !== TOKEN_ENDPOINT)) throw failure();
      const result = await readBoundedResponse(response);
      const { claims } = decodeJwt(result.id_token);
      const currentTime = Math.floor(now() / 1000);
      if (claims.aud !== config.audience ||
          !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) ||
          typeof claims.sub !== 'string' || !/^[0-9]{1,128}$/.test(claims.sub) ||
          !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
          claims.iat > currentTime + 60 || claims.exp <= currentTime + 30 ||
          claims.exp <= claims.iat || claims.exp - claims.iat > 3700 ||
          (claims.email !== undefined && claims.email !== config.serviceAccount) ||
          (claims.email_verified !== undefined && claims.email_verified !== true)) throw failure();
      // The fixed HTTPS Google exchange is the trust source; this shape/claim
      // check is not a replacement for Cloud Run's signature and IAM validation.
      return result.id_token;
    };
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(failure()); }, timeoutMs);
    });
    return await Promise.race([operation(), deadline]);
  } catch { throw failure(); }
  finally { clearTimeout(timer); controller.abort(); }
}
