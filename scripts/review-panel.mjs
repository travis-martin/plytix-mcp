import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { helperArgs, produceHelperOutput, parseHelperArgs } from './cloud-run-headers.mjs';
import { startReviewPanel } from './review-panel-server.mjs';
import { createReviewPanelFetch } from './review-panel-auth.mjs';

const SAFE_FAILURE = 'Review panel could not start. Check the review ID, configured service, built UI and authentication configuration. Credentials are never printed.';

export function parseReviewPanelOptions(args) {
  try {
    const { values, tokens } = parseArgs({ args, allowPositionals: false, strict: true, tokens: true,
      options: Object.fromEntries(['url', 'review', 'env-file', 'account', 'gcloud', 'machine-config', 'port'].map(key => [key, { type: 'string' }])) });
    const names = tokens.filter(token => token.kind === 'option').map(token => token.name);
    if (new Set(names).size !== names.length) throw new Error();
    const url = new URL(values.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    const authentication = parseHelperArgs(helperArgs({ envFile: values['env-file'], account: values.account,
      gcloud: values.gcloud, machineConfig: values['machine-config'], check: false }));
    const port = values.port === undefined ? 0 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error();
    return { url, reviewId: values.review, port, authentication };
  } catch { throw new Error(SAFE_FAILURE); }
}

async function main(args) {
  let panel, transport;
  const client = new Client({ name: 'Plytix review sidebar', version: '1' });
  try {
    const options = parseReviewPanelOptions(args);
    const headers = await produceHelperOutput(options.authentication);
    const fetch = createReviewPanelFetch({ url: options.url, initialHeaders: headers,
      getHeaders: () => produceHelperOutput(options.authentication) });
    transport = new StreamableHTTPClientTransport(options.url, { fetch, requestInit: { redirect: 'error' } });
    await client.connect(transport);
    const resource = await client.readResource({ uri: 'ui://plytix/workspace' });
    const workspaceHtml = resource.contents.find(c => typeof c.text === 'string')?.text;
    if (!workspaceHtml) throw new Error();
    const hostScript = await readFile(new URL('../dist/ui/review-panel-host.js', import.meta.url), 'utf8');
    panel = await startReviewPanel({ reviewId: options.reviewId, port: options.port, workspaceHtml, hostScript,
      callTool: toolArgs => client.callTool(toolArgs, undefined, { timeout: 240000 }) });
    console.log(`Review panel: ${panel.url}`);
    console.log('Local draft controls only. No product-write route is exposed.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await panel.close(); await transport.terminateSession().catch(() => {}); await client.close(); });
  } catch {
    console.error(SAFE_FAILURE);
    if (transport) await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {}); process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
