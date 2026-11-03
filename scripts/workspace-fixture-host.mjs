// Fixture-only browser harness. No credentials, Plytix client, or network API.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const iframe = document.getElementById('workspace');
const calls = [];
window.fixtureCalls = calls;
const bridge = new AppBridge(null, { name: 'Plytix fixture host', version: '1.0.0' }, {
  serverTools: {}, updateModelContext: { text: {} }, message: { text: {} },
}, { hostContext: { theme: 'light' } });
const envelope = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { data, metadata: { status: data.blocked?.length ? 'partial' : 'ok', freshness: 'live', coverage: 'not_asserted', warnings: [] } } });
const product = { id: 'fixture-a', sku: 'SHEET-A', label: 'Fixture sheet A', product_type: 'STANDALONE', product_family_id: 'fixture-family', attributes: { price: 10, brand: 'Fixture Brand', supplier: 'Fixture Supplier' } };
const change = { row_index: 0, product_id: 'fixture-a', sku: 'SHEET-A', family_id: 'fixture-family', attribute: 'price', old_value: 10, new_value: 12.5, currency: 'USD', unit: 'sheet', rule_id: 'fixture-price', source_ref: 'Supplier price list · page 1, row 2', inheritance_level: 'variant_level', review_evidence: { supplier: 'Fixture Supplier', grade: 'virgin', raw_width: 48, raw_length: 96 }, descendant_impact: [{ product_id: 'fixture-child', sku: 'CHILD-A', old_value: 10, new_value: 12.5, overridden: false }, { product_id: 'fixture-override', sku: 'CHILD-OVERRIDE', old_value: 14, new_value: 14, overridden: true }] };
const plan = { plan_id: '11111111-1111-4111-8111-111111111111', digest: 'a'.repeat(64), changes: [change], blocked: [], state: 'draft', rules_revision: 1 };
const reviewId = '33333333-3333-4333-8333-333333333333';
const clone = value => JSON.parse(JSON.stringify(value));
let guidance = { revision: 3, digest: 'c'.repeat(64), updated_at: '2026-11-03T00:00:00Z', history_count: 2,
  instructions: [
    { id: 'whole-sheet-cost', title: 'Use the full sheet cost', text: 'Confirm current raw dimensions before calculating the full sheet cost.', priority: 'required', status: 'active', scope: { family_ids: [] }, source_ref: 'Fixture owner instruction' },
    { id: 'retired-reference', title: 'Retired fixture instruction', text: 'Retained for review and audit.', priority: 'recommended', status: 'retired', scope: { family_ids: ['fixture-family'] }, source_ref: 'Fixture superseded instruction' },
  ],
  exclusions: [{ id: 'custom-color', title: 'Preserve custom color pricing', family_ids: ['fixture-family'], status: 'active', target_attributes: ['price'], all: [{ attribute: 'color', operator: 'equals', values: ['Fixture custom color'] }], reason: 'Custom supplier pricing must be reviewed separately.', source_ref: 'Fixture owner exception' }],
  storage_scope: { kind: 'organization', id: 'fixture-organization' }, storage_backend: { kind: 'local', shared_backend_required: true },
};
window.fixtureChangeGuidance = () => { guidance.revision++; guidance.digest = 'd'.repeat(64); };
const line = (suffix, state = 'pending', extra = {}) => ({ line_id: `line-${suffix}`, status: state, change: { ...clone(change), sku: `SHEET-${suffix}`, product_id: `fixture-${suffix.toLowerCase()}`, row_index: suffix.charCodeAt(0) - 65, source_ref: `Supplier price list · page 1, row ${suffix.charCodeAt(0) - 63}` }, provenance: { plan_id: plan.plan_id, import_id: '22222222-2222-4222-8222-222222222222', row_index: suffix.charCodeAt(0) - 65, rule_id: 'fixture-price', mapping: { product_id: `fixture-${suffix.toLowerCase()}`, family_id: 'fixture-family' } }, source: { source_name: 'Fixture supplier price list.pdf', source_ref: `Page 1, row ${suffix.charCodeAt(0) - 63}`, source_sha256: 'b'.repeat(64), source_column: 'Price', source_values: { SKU: `SHEET-${suffix}`, Price: suffix === 'B' ? '25.20' : suffix === 'F' ? '10.00' : '12.50', Width: '48', Length: '96' } }, ...extra });
const initialReview = { review_id: reviewId, revision: 0, title: 'Fixture supplier · sheet price review', lines: [
  line('A'), line('B', 'pending', { change: { ...clone(change), sku: 'SHEET-B', product_id: 'fixture-b', old_value: 24, new_value: 25.2, row_index: 1, source_ref: 'Supplier price list · page 1, row 3' } }),
  line('C', 'blocked', { change: undefined, reason: 'Source currency is not stated. Confirm it before preparing this line.' }),
  line('D', 'needs_revision', { instruction: 'Use the full-sheet amount after confirming the pack size.', proposed_value: '13.25' }),
  line('E', 'rejected', { instruction: 'Discontinued item — exclude from this update.' }),
  line('F', 'unchanged', { change: { ...clone(change), sku: 'SHEET-F', product_id: 'fixture-f', old_value: 10, new_value: 10, row_index: 5, source_ref: 'Supplier price list · page 1, row 7' } }),
] };
let review = clone(initialReview);
let preparedLineIds = [];
window.fixtureBlockApproval = false;
window.fixtureBatchLimit = 100;
window.fixtureChangedLine = null;
window.fixtureLargeReview = (status = 'selected') => {
  review = { ...clone(initialReview), revision: review.revision + 1, lines: Array.from({ length: 125 }, (_, index) => {
    const item = line(`L${index}`, status); item.change.descendant_impact = [];
    item.change.row_index = index; item.provenance.row_index = index;
    return item;
  }) };
  preparedLineIds = []; window.fixtureBatchLimit = 10; window.fixtureChangedLine = null;
};
window.fixtureOpenReview = async () => { await bridge.sendToolInput({ arguments: { review_id: reviewId } }); await bridge.sendToolResult(envelope({ tabs: ['products', 'dictionary', 'pricing'], review_id: reviewId })); };
window.fixtureCompletePrepared = () => { for (const id of preparedLineIds) { const row = review.lines.find(line => line.line_id === id); row.execution = { status: 'verified', message: 'Fixture readback matches the approved amount.' }; } review.revision++; };
function checkedReview(args) { if (args.review_id !== reviewId) throw new Error('Fixture review not found.'); if (args.expected_revision !== undefined && args.expected_revision !== review.revision) throw new Error('Review changed. Refresh before saving decisions.'); }
bridge.oncalltool = async ({ name, arguments: args }) => {
  calls.push({ name, arguments: args });
  switch (name) {
    case 'products_lookup': return envelope({ selected: null, product: null, alternativeMatches: [{ id: 'fixture-a', sku: 'SHEET-A', label: 'Fixture sheet A', confidence: .9 }, { id: 'fixture-b', sku: 'SHEET-B', label: 'Fixture sheet B', confidence: .9 }], searchPlan: ['fixture'] });
    case 'products_get_full': return envelope({ product: { ...product, id: args.product_id }, family: { id: 'fixture-family', name: 'Fixture Sheets' }, assets: [{ id: 'asset', filename: 'sheet-photo.jpg', alt_text: 'Fixture sheet' }] });
    case 'products_inspect_inheritance': return envelope({ attributes: [{ label: 'price', levels: [{ product_id: 'fixture-a', reported_value: { status: 'reported', value: 10 }, override_marker: 'not_marked_overwritten', family_attribute: { attribute_level: 'parent_level' } }] }], ancestry: [{ product_id: 'fixture-a', product_type: 'STANDALONE' }], ancestry_status: { complete: true }, errors: [] });
    case 'catalog_dictionary': return envelope({ definitions: [{ term: 'List price', status: 'confirmed', meaning: 'Supplier list price per sheet', attribute_labels: ['price'], family_ids: ['fixture-family'], evidence: 'Fixture reviewed rule', updated_at: '2026-11-03T00:00:00Z' }], definitions_pagination: { has_more: false }, observations_pagination: { has_more: false }, observations: [], live_schema: { status: 'available', attributes: [{ label: 'price', type_class: 'NumberAttribute' }] } });
    case 'pricing_dictionary_get': return envelope({ revision: 2, entries: [{ value: { kind: 'color', term: args.page === 2 ? 'Smoke' : 'CLR', definition: args.page === 2 ? 'Supplier gray tint; verify the current Plytix option.' : 'Supplier abbreviation for clear material; validate against the current color attribute.', scope: { supplier: 'Fixture supplier', source_namespace: 'Fixture sheets' } }, status: 'proposed', updated_at: '2026-11-03T00:00:00Z', stale_source: false, evidence: [{ source: 'document', reference: 'Fixture price list, page 1', observed_at: '2026-11-03T00:00:00Z' }] }], page: args.page, has_more: args.page === 1 });
    case 'pricing_guidance_get': return envelope({ ...clone(guidance), complete_for_save: args.include_retired === true && !args.family_ids?.length && !args.source_context });
    case 'pricing_rules_get': return envelope({ revision: 1, rules: [{ id: 'fixture-price', status: 'confirmed', family_ids: ['fixture-family'], target_attribute: 'price' }] });
    case 'pricing_import': return envelope({ import_id: '22222222-2222-4222-8222-222222222222', family_suggestions: [{ family_id: 'fixture-family', name: 'Fixture Sheets', matched_rows: 1 }], matches: [{ row_index: 0, sku: 'SHEET-A', status: 'matched', candidates: [{ product_id: 'fixture-a', sku: 'SHEET-A', family_id: 'fixture-family' }] }] });
    case 'pricing_plan': case 'pricing_plan_get': return envelope(plan);
    case 'pricing_review_create': review = clone(initialReview); if (args.title) review.title = args.title; return envelope(review);
    case 'pricing_review_get': checkedReview(args); return envelope(review);
    case 'pricing_review_update': {
      checkedReview(args);
      for (const decision of args.decisions) {
        const row = review.lines.find(line => line.line_id === decision.line_id);
        if (!row || row.execution) throw new Error('This fixture line cannot be edited.');
        if (decision.status === 'selected' && !['pending', 'selected'].includes(row.status)) throw new Error('Recalculate and review this line first.');
        row.status = decision.status;
        if (decision.note !== undefined) row.instruction = decision.note;
        if (decision.proposed_value !== undefined) row.proposed_value = decision.proposed_value;
        if (decision.note !== undefined || decision.proposed_value !== undefined) row.status = 'needs_revision';
      }
      preparedLineIds = []; review.revision++; return envelope(review);
    }
    case 'pricing_review_plan': {
      checkedReview(args);
      const requested = review.lines.filter(row => args.line_ids ? args.line_ids.includes(row.line_id) : row.status === 'selected' && !row.execution);
      const selected = requested.slice(0, window.fixtureBatchLimit);
      // A deliberately small fixture manifest allowance exercises deferred UI
      // without constructing large source strings; production computes exact size.
      const batching = { requested: requested.length, prepared: selected.length, deferred_count: requested.length - selected.length, deferred_line_ids: requested.slice(selected.length).map(row => row.line_id), reasons: requested.length > selected.length ? ['approval_size_limit'] : [], max_changes: 100, estimated_api_requests: selected.length * 11, max_estimated_api_requests: 2048 };
      if (!selected.length) throw new Error('Choose at least one review line.');
      if (args.line_ids && selected.some(row => row.status !== 'selected')) {
        for (const row of selected) if (row.change) {
          const sourceValue = Number(row.source.source_values.Price);
          if (row.proposed_value !== undefined && row.proposed_value !== null) { row.change.calculated_value = sourceValue; row.change.new_value = Number(row.proposed_value); row.change.review_note = row.instruction; }
          else { row.change.new_value = sourceValue; delete row.change.calculated_value; }
          if (row.instruction) row.change.review_note = row.instruction; else delete row.change.review_note;
          for (const child of row.change.descendant_impact ?? []) if (!child.overridden) child.new_value = row.change.new_value;
          row.status = row.change.old_value === row.change.new_value ? 'unchanged' : 'pending';
        }
        review.revision++; preparedLineIds = []; return envelope({ review, plans: [], pending_review: true, batching });
      }
      const changed = selected.filter(row => row.line_id === window.fixtureChangedLine);
      for (const row of changed) { row.change.new_value += 1; row.status = 'pending'; }
      const ready = selected.filter(row => row.status === 'selected');
      preparedLineIds = ready.map(row => row.line_id); review.revision++;
      const approval = { tool_name: 'pricing_review_apply', arguments: { review_id: review.review_id, expected_revision: review.revision, plans: [{ plan_id: plan.plan_id, digest: plan.digest }], changes: ready.map(row => ({ line_id: row.line_id, ...row.change })) } };
      const plans = [{ ...plan, changes: ready.map(row => row.change), expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }, ...(changed.length ? [{ ...plan, plan_id: '77777777-7777-4777-8777-777777777777', changes: changed.map(row => row.change) }] : [])];
      return envelope({ review, pending_review: Boolean(changed.length), batching, plans, ...(window.fixtureBlockApproval ? { approval_blocked: 'The complete approval manifest is too large; prepare a smaller checked selection. Saved decisions are unchanged.' } : { approval }) });
    }
    default: throw new Error('No fixture exists for this tool; no network request was made.');
  }
};
bridge.onupdatemodelcontext = async context => { window.fixtureContext = context; document.getElementById('attached').textContent = 'Selection attached'; return {}; };
bridge.onmessage = async message => { window.fixtureMessage = message; document.getElementById('attached').textContent = 'Final approval requested; no fixture catalog write'; return {}; };
await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
iframe.src = '/workspace';
