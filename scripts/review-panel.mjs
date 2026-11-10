import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { produceHelperOutput, parseHelperArgs } from './cloud-run-headers.mjs';
import { startReviewPanel } from './review-panel-server.mjs';

const { values } = parseArgs({ options: Object.fromEntries(['url', 'review', 'env-file', 'account', 'gcloud', 'port'].map(key => [key, { type: 'string' }])) });
let panel, transport;
const client = new Client({ name: 'Plytix review sidebar', version: '1' });
try {
  const url = new URL(values.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
  const options = parseHelperArgs(['--env-file', values['env-file'], '--account', values.account, '--gcloud', values.gcloud]);
  const headers = await produceHelperOutput(options);
  transport = new StreamableHTTPClientTransport(url, { requestInit: { headers, redirect: 'error' } });
  await client.connect(transport);
  const resource = await client.readResource({ uri: 'ui://plytix/workspace' });
  const workspaceHtml = resource.contents.find(c => typeof c.text === 'string')?.text;
  if (!workspaceHtml) throw new Error();
  const hostScript = await readFile(new URL('../dist/ui/review-panel-host.js', import.meta.url), 'utf8');
  panel = await startReviewPanel({ reviewId: values.review, port: values.port ? Number(values.port) : 0, workspaceHtml, hostScript,
    callTool: args => client.callTool(args, undefined, { timeout: 240000 }) });
  console.log(`Review panel: ${panel.url}`);
  console.log('Local draft controls only. No product-write route is exposed.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await panel.close(); await transport.terminateSession().catch(() => {}); await client.close(); });
} catch {
  console.error('Review panel could not start. Check the review ID, configured service, built UI and existing sign-in. Credentials are never printed.');
  if (transport) await transport.terminateSession().catch(() => {});
  await client.close().catch(() => {}); process.exitCode = 1;
}
