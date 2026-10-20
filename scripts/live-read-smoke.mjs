/**
 * Opt-in, bounded read-only integration check. Uses existing local credentials,
 * prints only statuses/counts, and never persists product data or credentials.
 * Build first. Not part of npm test/CI.
 */
import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const client = new Client({ name: 'plytix-read-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  env: { ...process.env, PLYTIX_WRITE_TOOLS: '[]', MCP_KNOWLEDGE_WRITE_TOOLS: '[]', MCP_KNOWLEDGE_CONFIG: '' },
  stderr: 'ignore',
});
const results = [];
let available = new Map();
async function check(name, args = {}) {
  // Keep this full-catalog audit from bursting requests against a live account.
  // Composite tools may make several upstream reads of their own.
  await new Promise(resolve => setTimeout(resolve, 500));
  if (!available.has(name)) {
    results.push({ tool: name, status: 'unavailable' });
    console.log(JSON.stringify(results.at(-1)));
    return null;
  }
  if (available.get(name).annotations?.readOnlyHint !== true) throw new Error('Refusing non-read tool');
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
    const text = result.content?.find(item => item.type === 'text')?.text ?? '';
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* Errors are summarized below, never dumped. */ }
    const partial = parsed?._errors?.length || parsed?.errors?.length || parsed?.partial === true;
    const statusCode = result.isError || partial ? /HTTP (\d{3})/.exec(text)?.[1] : undefined;
    const entry = {
      tool: name,
      status: result.isError ? (statusCode === '403' ? 'access_limited' : 'failed') : partial ? 'partial' : 'passed',
      ...(statusCode ? { http_status: Number(statusCode) } : {}),
    };
    results.push(entry);
    console.log(JSON.stringify(entry));
    return parsed;
  } catch {
    results.push({ tool: name, status: 'protocol_failed' });
    console.log(JSON.stringify(results.at(-1)));
    return null;
  }
}

try {
  await client.connect(transport);
  const catalog = await client.listTools();
  available = new Map(catalog.tools.map(tool => [tool.name, tool]));
  if (catalog.tools.some(tool => tool.annotations?.readOnlyHint !== true)) throw new Error('Unexpected write exposure');
  await check('server_capabilities');
  await check('discovery_guide');
  await check('knowledge_status');
  await check('catalog_dictionary', { page_size: 2 });
  await check('identifier_detect', { value: 'EXAMPLE-123' });
  await check('identifier_normalize', { value: 'EXAMPLE-123' });
  await check('match_score', { identifier: 'EXAMPLE-123', product_data: { sku: 'EXAMPLE-123' } });
  const filters = await check('products_filters');
  await check('attributes_filters');
  await check('assets_filters');
  await check('relationships_filters');
  const attributes = await check('attributes_list', { include_options: false });
  // This invariant catches the historical empty attribute discovery bug.
  if (filters?.filters?.some(f => f.key?.startsWith('attributes.')) && !attributes?.summary?.custom_count) {
    results.push({ tool: 'attributes_list', status: 'invariant_failed' });
  }
  const schema = await check('attributes_search', { page_size: 2 });
  const groups = await check('attribute_groups_search', { page_size: 2 });
  if (groups?.groups?.[0]?.id) await check('attributes_search', { group_id: groups.groups[0].id, page_size: 2 });
  await check('attributes_search', { type_class: 'CompletenessAttribute', page_size: 2 });
  const label = schema?.attributes?.[0]?.label;
  if (label) {
    await check('attributes_get', { label });
    await check('attributes_get_options', { label });
    await check('attributes_profile_usage', { attribute_labels: [label], max_products: 2 });
  }
  const families = await check('families_list', { page_size: 2 });
  const familyId = families?.families?.[0]?.id;
  if (familyId) {
    await check('families_get', { family_id: familyId });
    await check('families_list_attributes', { family_id: familyId });
    await check('families_list_all_attributes', { family_id: familyId });
    await check('families_inspect', { family_id: familyId });
  }
  const products = await check('products_search', { pagination: { page: 1, page_size: 1 }, attributes: ['sku', 'label'] });
  const product = products?.products?.[0];
  if (product?.id) {
    await check('products_get', { product_id: product.id });
    await check('products_get_full', { product_id: product.id });
    await check('products_get_full', { product_id: product.id, include: [] });
    await check('products_get_full', { product_id: product.id, include: ['assets'] });
    await check('variants_list', { product_id: product._parent_id ?? product.id });
    await check('categories_list', { product_id: product.id });
    await check('assets_list', { product_id: product.id });
    if (label && available.has('products_inspect_inheritance')) {
      await check('products_inspect_inheritance', { product_id: product.id, attribute_labels: [label] });
    }
    if (product.sku) {
      await check('products_lookup', { identifier: product.sku, type: 'sku', limit: 1 });
      await check('products_find', { sku: product.sku, limit: 1 });
    }
  }
  const assets = await check('assets_search', { pagination: { page: 1, page_size: 1 } });
  if (assets?.assets?.[0]?.id) await check('assets_get', { asset_id: assets.assets[0].id });
  await check('asset_categories_search', { pagination: { page: 1, page_size: 2 } });
  await check('categories_search', { pagination: { page: 1, page_size: 2 } });
  const relationships = await check('relationships_search', { pagination: { page: 1, page_size: 1 } });
  if (relationships?.relationships?.[0]?.id) {
    const relationship_id = relationships.relationships[0].id;
    await check('relationships_get', { relationship_id });
    for (const operator of ['exists', '!exists']) {
      await check('products_search', {
        relationship_filters: [[{ relationship_id, operator }]],
        pagination: { page: 1, page_size: 1 }, attributes: ['sku'],
      });
    }
  }
  const checked = new Set(results.map(item => item.tool));
  const unchecked = [...available.keys()].filter(name => !checked.has(name));
  const failures = results.filter(item => ['failed', 'protocol_failed', 'invariant_failed', 'unavailable'].includes(item.status));
  console.log(JSON.stringify({ summary: { advertised_read_tools: available.size, calls: results.length, failures: failures.length, limitations: results.filter(r => ['access_limited', 'partial'].includes(r.status)).length, unchecked } }));
  if (failures.length || unchecked.length) process.exitCode = 1;
} catch {
  console.error('Read smoke check could not complete; check local build/configuration.');
  process.exitCode = 1;
} finally {
  await client.close();
}
