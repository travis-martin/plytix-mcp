// Fixture-only browser harness. No credentials, Plytix client, or network API.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const iframe = document.getElementById('workspace');
const calls = [];
window.fixtureCalls = calls;
const bridge = new AppBridge(null, { name: 'Plytix fixture host', version: '1.0.0' }, {
  serverTools: {}, updateModelContext: { text: {} },
}, { hostContext: { theme: 'light' } });
const envelope = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { data, metadata: { status: data.blocked?.length ? 'partial' : 'ok', freshness: 'live', coverage: 'not_asserted', warnings: [] } } });
const product = { id: 'fixture-a', sku: 'SHEET-A', label: 'Fixture sheet A', product_type: 'STANDALONE', product_family_id: 'fixture-family', attributes: { price: 10, brand: 'Fixture Brand', supplier: 'Fixture Supplier' } };
const change = { row_index: 0, product_id: 'fixture-a', sku: 'SHEET-A', family_id: 'fixture-family', attribute: 'price', old_value: 10, new_value: 12.5, currency: 'USD', unit: 'sheet', rule_id: 'fixture-price', source_ref: 'CSV row 2', inheritance_level: 'parent_level', descendant_impact: [{ product_id: 'fixture-child', sku: 'CHILD-A', old_value: 10, new_value: 12.5, overridden: false }] };
const plan = { plan_id: '11111111-1111-4111-8111-111111111111', digest: 'a'.repeat(64), changes: [change], blocked: [], state: 'draft', rules_revision: 1 };
bridge.oncalltool = async ({ name, arguments: args }) => {
  calls.push({ name, arguments: args });
  switch (name) {
    case 'products_lookup': return envelope({ selected: null, product: null, alternativeMatches: [{ id: 'fixture-a', sku: 'SHEET-A', label: 'Fixture sheet A', confidence: .9 }, { id: 'fixture-b', sku: 'SHEET-B', label: 'Fixture sheet B', confidence: .9 }], searchPlan: ['fixture'] });
    case 'products_get_full': return envelope({ product: { ...product, id: args.product_id }, family: { id: 'fixture-family', name: 'Fixture Sheets' }, assets: [{ id: 'asset', filename: 'sheet-photo.jpg', alt_text: 'Fixture sheet' }] });
    case 'products_inspect_inheritance': return envelope({ attributes: [{ label: 'price', levels: [{ product_id: 'fixture-a', reported_value: { status: 'reported', value: 10 }, override_marker: 'not_marked_overwritten', family_attribute: { attribute_level: 'parent_level' } }] }], ancestry: [{ product_id: 'fixture-a', product_type: 'STANDALONE' }], ancestry_status: { complete: true }, errors: [] });
    case 'catalog_dictionary': return envelope({ definitions: [{ term: 'List price', status: 'confirmed', meaning: 'Supplier list price per sheet', attribute_labels: ['price'], family_ids: ['fixture-family'], evidence: 'Fixture reviewed rule', updated_at: '2026-11-03T00:00:00Z' }], definitions_pagination: { has_more: false }, observations_pagination: { has_more: false }, observations: [], live_schema: { status: 'available', attributes: [{ label: 'price', type_class: 'NumberAttribute' }] } });
    case 'pricing_rules_get': return envelope({ revision: 1, rules: [{ id: 'fixture-price', status: 'confirmed', family_ids: ['fixture-family'], target_attribute: 'price' }] });
    case 'pricing_import': return envelope({ import_id: '22222222-2222-4222-8222-222222222222', family_suggestions: [{ family_id: 'fixture-family', name: 'Fixture Sheets', matched_rows: 1 }], matches: [{ row_index: 0, sku: 'SHEET-A', status: 'matched', candidates: [{ product_id: 'fixture-a', sku: 'SHEET-A', family_id: 'fixture-family' }] }] });
    case 'pricing_plan': case 'pricing_plan_get': return envelope(plan);
    default: throw new Error('No fixture exists for this tool; no network request was made.');
  }
};
bridge.onupdatemodelcontext = async context => { window.fixtureContext = context; document.getElementById('attached').textContent = 'Selection attached'; return {}; };
await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
iframe.src = '/workspace';
