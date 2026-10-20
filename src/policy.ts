export const WRITE_TOOLS = new Set([
  'products_create', 'products_update', 'products_assign_family',
  'products_set_attribute', 'products_clear_attribute',
  'families_create', 'families_link_attribute', 'families_unlink_attribute',
  'assets_update', 'assets_link', 'assets_unlink', 'categories_link', 'categories_unlink',
  'variants_create', 'variants_link', 'variants_unlink', 'variants_resync',
  'relationships_link_product', 'relationships_unlink_product', 'relationships_set_quantity',
]);

export const READ_TOOLS = new Set([
  'discovery_guide', 'catalog_dictionary', 'knowledge_status',
  'products_lookup', 'products_get', 'products_get_full', 'products_search', 'products_find',
  'families_list', 'families_get', 'families_list_attributes', 'families_list_all_attributes',
  'attributes_list', 'attributes_get', 'attributes_get_options', 'attributes_filters',
  'products_filters', 'assets_filters', 'relationships_filters',
  'assets_get', 'assets_search', 'assets_list', 'categories_search', 'categories_list',
  'variants_list', 'relationships_get', 'relationships_search',
  'identifier_detect', 'identifier_normalize', 'match_score',
  'asset_categories_search', 'server_capabilities',
  'attributes_search', 'attribute_groups_search', 'attributes_profile_usage', 'families_inspect',
  'products_inspect_inheritance',
]);

export const KNOWLEDGE_WRITE_TOOLS = new Set(['knowledge_propose']);
export function parseKnowledgeWriteTools(value = '[]'): Set<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('MCP_KNOWLEDGE_WRITE_TOOLS must be a JSON array'); }
  if (!Array.isArray(parsed) || parsed.some(name => !KNOWLEDGE_WRITE_TOOLS.has(name))) {
    throw new Error('MCP_KNOWLEDGE_WRITE_TOOLS contains an unknown tool');
  }
  return new Set(parsed);
}

export function parseWriteTools(value = '[]'): Set<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('PLYTIX_WRITE_TOOLS must be a JSON array'); }
  if (!Array.isArray(parsed) || parsed.some(name => typeof name !== 'string' || !WRITE_TOOLS.has(name))) {
    throw new Error('PLYTIX_WRITE_TOOLS contains an unknown write tool');
  }
  return new Set(parsed);
}

// Permit only exact known search POSTs as reads; unknown POSTs fail closed.
const SEARCH_PATHS = new Set([
  '/api/v2/products/search', '/api/v1/product_families/search',
  '/api/v1/attributes/product/search', '/api/v1/assets/search',
  '/api/v1/categories/product/search', '/api/v1/relationships/search',
  '/api/v1/categories/file/search',
  '/api/v1/attribute-groups/product/search',
]);
export function isReadRequest(endpoint: string, method = 'GET'): boolean {
  return method === 'GET' || (method === 'POST' && SEARCH_PATHS.has(endpoint));
}

// A tool's allowlist entry authorizes only the API routes needed by that tool.
// In particular, an allowed update must never authorize a create/delete route.
const WRITE_ROUTES: Record<string, { method: string; path: RegExp }> = {
  products_create: { method: 'POST', path: /^\/api\/v2\/products$/ },
  products_update: { method: 'PATCH', path: /^\/api\/v2\/products\/[^/]+$/ },
  products_set_attribute: { method: 'PATCH', path: /^\/api\/v2\/products\/[^/]+$/ },
  products_clear_attribute: { method: 'PATCH', path: /^\/api\/v2\/products\/[^/]+$/ },
  products_assign_family: { method: 'POST', path: /^\/api\/v2\/products\/[^/]+\/family$/ },
  families_create: { method: 'POST', path: /^\/api\/v1\/product_families$/ },
  families_link_attribute: { method: 'POST', path: /^\/api\/v1\/product_families\/[^/]+\/attributes\/link$/ },
  families_unlink_attribute: { method: 'POST', path: /^\/api\/v1\/product_families\/[^/]+\/attributes\/unlink$/ },
  assets_update: { method: 'PATCH', path: /^\/api\/v1\/assets\/[^/]+$/ },
  assets_link: { method: 'POST', path: /^\/api\/v2\/products\/[^/]+\/assets$/ },
  assets_unlink: { method: 'DELETE', path: /^\/api\/v2\/products\/[^/]+\/assets\/[^/]+$/ },
  categories_link: { method: 'POST', path: /^\/api\/v2\/products\/[^/]+\/categories$/ },
  categories_unlink: { method: 'DELETE', path: /^\/api\/v2\/products\/[^/]+\/categories\/[^/]+$/ },
  variants_create: { method: 'POST', path: /^\/api\/v2\/products\/[^/]+\/variants$/ },
  variants_link: { method: 'POST', path: /^\/api\/v2\/products\/[^/]+\/variant\/[^/]+$/ },
  variants_unlink: { method: 'DELETE', path: /^\/api\/v2\/products\/[^/]+\/variant\/[^/]+$/ },
  variants_resync: { method: 'POST', path: /^\/api\/v2\/products\/[^/]+\/variants\/resync$/ },
  relationships_link_product: { method: 'POST', path: /^\/api\/v2\/products\/[^/]+\/relationships\/[^/]+$/ },
  relationships_unlink_product: { method: 'DELETE', path: /^\/api\/v2\/products\/[^/]+\/relationships\/[^/]+$/ },
  relationships_set_quantity: { method: 'PATCH', path: /^\/api\/v2\/products\/[^/]+\/relationships\/[^/]+$/ },
};

export function isWriteRequestForTool(toolName: string, endpoint: string, method: string): boolean {
  const route = Object.prototype.hasOwnProperty.call(WRITE_ROUTES, toolName) ? WRITE_ROUTES[toolName] : undefined;
  return route !== undefined && route.method === method && route.path.test(endpoint);
}
