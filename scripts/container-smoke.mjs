// Local fixtures only. Never substitute production credentials into this script.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { READ_TOOLS } from '../dist/policy.js';

const image = process.argv[2] ?? 'plytix-mcp:local';
const name = `plytix-mcp-fixture-${process.pid}`;
const fixtureToken = 'fixture-container-test-token-not-for-real-use';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
let client;
let started = false;
try {
  docker('run', '--rm', '--detach', '--name', name, '--memory', '256m', '--cpus', '0.25',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--publish', '127.0.0.1::8080', '--env', `MCP_AUTH_TOKEN=${fixtureToken}`, image);
  started = true;
  const published = docker('port', name, '8080/tcp');
  assert.match(published, /^127\.0\.0\.1:\d+$/);
  const url = `http://${published}`;
  let healthy = false;
  for (let i = 0; i < 50; i++) {
    try { healthy = (await fetch(`${url}/health`)).ok; } catch { /* Startup only. */ }
    if (healthy) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(healthy, 'container must start within ten seconds under proposed resource limits');
  assert.equal((await fetch(`${url}/mcp`)).status, 401);
  client = new Client({ name: 'fixture-container-client', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: {
    'X-MCP-Token': fixtureToken, 'X-Plytix-API-Key': 'fixture', 'X-Plytix-API-Password': 'fixture',
  } } }));
  const tools = (await client.listTools()).tools;
  assert.deepEqual(new Set(tools.map(tool => tool.name)), READ_TOOLS);
  assert.ok(tools.every(tool => tool.annotations?.readOnlyHint));
  const result = await client.callTool({ name: 'identifier_detect', arguments: { value: 'ABC-123' } });
  assert.notEqual(result.isError, true);
  const denied = await client.callTool({ name: 'products_update', arguments: { product_id: 'fixture' } });
  assert.equal(denied.isError, true);
  const identity = JSON.parse(docker('inspect', '--format', '{{json .Config.User}}', name));
  assert.equal(identity, 'node');
  const memory = docker('stats', '--no-stream', '--format', '{{.MemUsage}}', name);
  const nodeVersion = docker('exec', name, 'node', '--version');
  console.log(JSON.stringify({ image, nodeVersion, user: identity, cpu: 0.25, memoryLimitMiB: 256,
    memoryUsage: memory, readOnlyTools: tools.length, authenticatedSdkHandshake: 'passed', mutationDenied: true }));
} finally {
  await client?.close();
  if (started) docker('stop', '--time', '2', name);
}
