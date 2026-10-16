export const WRITE_TOOLS = new Set([
  'products_create', 'products_update', 'products_assign_family',
  'products_set_attribute', 'products_clear_attribute',
  'families_create', 'families_link_attribute', 'families_unlink_attribute',
  'assets_update', 'assets_link', 'assets_unlink', 'categories_link', 'categories_unlink',
  'variants_create', 'variants_link', 'variants_unlink', 'variants_resync',
  'relationships_link_product', 'relationships_unlink_product', 'relationships_set_quantity',
]);

export const READ_TOOLS = new Set([
  'products_lookup', 'products_get', 'products_get_full', 'products_search', 'products_find',
  'families_list', 'families_get', 'families_list_attributes', 'families_list_all_attributes',
  'attributes_list', 'attributes_get', 'attributes_get_options', 'attributes_filters',
  'products_filters', 'assets_filters', 'relationships_filters',
  'assets_get', 'assets_search', 'assets_list', 'categories_search', 'categories_list',
  'variants_list', 'relationships_get', 'relationships_search',
  'identifier_detect', 'identifier_normalize', 'match_score',
]);

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
]);
export function isReadRequest(endpoint: string, method = 'GET'): boolean {
  return method === 'GET' || (method === 'POST' && SEARCH_PATHS.has(endpoint));
}
