import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const iframe = document.getElementById('workspace');
const config = window.reviewPanelConfig;
const bridge = new AppBridge(null, { name: 'Plytix review sidebar', version: '1' }, { serverTools: {} }, { hostContext: { theme: 'light' } });
async function tool(name, args) {
  const response = await fetch('/tool', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Panel-Token': config.token }, body: JSON.stringify({ name, arguments: args }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Review request failed');
  return result;
}
bridge.oncalltool = ({ name, arguments: args }) => tool(name, args ?? {});
bridge.oninitialized = async () => {
  try {
    const result = await tool('pricing_review_get', { review_id: config.reviewId });
    if (result.isError) throw new Error('Saved review could not be loaded');
    const envelope = result.structuredContent ?? { data: JSON.parse(result.content.find(c => c.type === 'text').text) };
    envelope.data = { ...envelope.data, review_panel: true };
    await bridge.sendToolResult({ ...result, structuredContent: envelope });
  } catch { document.getElementById('panel-status').textContent = 'The review could not be loaded. Reopen the panel after checking the connection.'; }
};
void bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow)).then(() => { iframe.src = '/workspace'; });
