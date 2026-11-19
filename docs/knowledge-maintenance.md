# Organization knowledge maintenance

Version 0.14 adds per-record sources and review history, reviewed portable import
preparation, revision-linked export refresh, and reusable full-item calculations
that read current stock dimensions. Business-specific instructions stay in the
organization store, never in the reusable package.

## Sources and reviewed changes

`pricing_guidance_save`, `pricing_dictionary_update` and `pricing_rules_save`
accept review sources, reason and optional supplied reviewer name. The server
records before/after values, time, revision and content digests atomically with
the change. Imported history cannot replace that history, and reviewer names do
not grant approval. Missing legacy history remains unknown. See
[record provenance](pricing-provenance.md) for the schema and retention limits.

The Dictionary UI exposes history and collects source, reason and optional
reviewer before attaching a guidance-save request. The request remains a draft.

Keep four kinds of knowledge separate: business instructions and protections in
workflow guidance; advisory terminology/mappings in the dictionary; executable
arithmetic and conditions in reviewed rules; and dated catalog observations,
source prices, supplier slots and sizes in private review evidence. An observed
slot or dimension is not a permanent business rule. A saved alias is not proof
that current product identity still matches.

When all learning must be proposed first, use `learning_mode: "proposal_only"`
on imports, rule reads and catalog dictionary reads. Plans inherit the import
mode and review replanning preserves it. Candidate definitions are returned with
source evidence instead of being saved; imports/plans retain them privately as
`learning_proposal`. Neither the pricing dictionary nor the dictionary read's
shared-schema store changes. The default remains automatic for compatibility.
Review the candidates, fetch current revisions, then save only authorized
definitions/instructions/rules through their existing tools. This mode does not
approve a later save or disable private review records.

Structured family/color exclusions remain enforced during planning and execution,
including inherited descendant effects. A new source price does not override a
protection. Any edit to an existing active exclusion requires review sources and
a reason. When new instructions supersede a rule or a source documents an
uncovered conflict, hold affected changes and ask for guidance unless the current
user instruction already resolves it. Show the exact rule, evidence and proposed
resolution. After the reviewed guidance update, create a new pricing plan and
obtain any required approval for the actual catalog changes. Do not retire
protections merely to make a blocked calculation run.

## General full-item cost calculations

New or changed saved `supplier_1_cost` through `supplier_4_cost` rules require
`full_item_cost`. Fixed physical sizes belong to dated run evidence, not reusable
arithmetic. Existing unchanged legacy rules and historical runs remain readable;
they are not silently converted or reapproved. Private one-run `batch_rules`
remain available for explicitly reviewed exceptions.

For example, this block describes per-length costing without encoding a stock
length:

```json
{
  "price_basis": "length",
  "price_unit": "ft",
  "price_unit_column": "Source price unit",
  "dimensions": [{
    "product_attribute": "raw_material_length",
    "product_unit": "in",
    "source": {
      "value_column": "Source full length",
      "unit_column": "Source dimension unit"
    }
  }]
}
```

This is an illustrative block, not a complete rule or account default. Resolve
the actual labels, units and columns first. Fixed `product_unit` describes
reviewed schema units; alternatively bind a live `product_unit_attribute`.
Neither stores a physical length. Supported length units are `mm`, `cm`, `m`,
`in`, `ft`; area price units add `2` (for example `ft2`). Price bases are `item`,
`length`, `area`. Length uses one dimension, area two distinct dimensions; item
pricing needs no dimensional multiplier.

Every row must state its source price unit in the configured column. Catalog
dimensions are read fresh; missing/nonpositive dimensions or unsupported units
block the row. Document dimension bindings are optional. When both source
dimension and unit are supplied they must agree exactly after unit conversion;
a partial pair or mismatch blocks the row. Do not substitute a document size for
a missing catalog dimension or overwrite dimensions as part of a price edit.
Resolve missing/conflicting evidence as a separate reviewed action.

The engine uses exact rational conversion and rounds the final result. The review
trace records source price/basis, resolved dimensions/units and full quantity.
Inheriting descendants must have compatible full-item dimensions; equal rounded
cost alone is insufficient. Manually modified proposed costs are final full-item
amounts, not unit prices to multiply again.

Optional additional arithmetic on new reusable supplier-cost rules must declare
`role: "pricing_adjustment"` and explain its purpose in reviewed evidence. This
is for genuine pricing adjustments, not disguising a stock-size constant.
Arbitrary expressions/code are not supported. Existing family, supplier,
currency, bounds, source conditions and approval checks still apply.

## Compatibility and activation

Old documents can be read without migration. Once a 0.14 writer stores provenance
or full-item fields, older strict-schema servers cannot reliably read those
documents. Upgrade all readers/writers using that backend before new writes.
Keep a verified pre-upgrade backup. Rolling back the executable alone is
insufficient after new-format records are saved; do not discard newer history to
force a downgrade. Reconcile any data restore separately and preserve audits.

The offline import and refresh workflow is described in
[portable knowledge](portable-knowledge.md). It does not deploy a server, grant
write access or synchronize independent local and remote stores automatically.
