# API coverage and version decisions

Reviewed against the [official Plytix API reference](https://apidocs.plytix.com/)
on October 20, 2026. The reference's
[published Postman collection](https://apidocs.plytix.com/api/collections/42465620/2sBYB2qSYS?segregateAuth=true&versionTag=latest)
is the source of the route and request contracts below. These are documentation
checks, not evidence that a particular account can execute every operation.

## Versions

Product v2 is preferred for supported product operations. Its lightweight
responses avoid unnecessarily expanding linked assets and categories. This server
uses v2 for product reads, searches, relationship operations, and other supported
product writes, and v1 for schema, families, relationship definitions, taxonomy,
and account assets. Variant listing uses the documented
`GET /api/v1/products/{id}/variants`; the current v2 reference does not define a
corresponding GET route. The reference's beta label is informational, not a
reason to avoid useful v2 operations.

Product v2 reads can return asset/category IDs instead of hydrated objects.
`products_get_full`, `assets_list`, and `categories_list` retrieve related data
separately. V2 create/update responses may contain only IDs and audit timestamps;
they are not full product snapshots.

`products_get_full` accepts `include` with any of `family`, `variants`,
`categories`, and `assets`. Omission preserves the original full expansion;
`include: []` reads only the product. Unrequested sections are omitted.
Identical reads within one tool invocation share one upstream request; this
deduplication expires at the end of the invocation and is cleared before a write,
so mutation readback is fresh.

## Discovery contracts

| New tool | Agent use |
| --- | --- |
| `attributes_search` | Find attribute names, labels, types, groups, options and completeness members |
| `attribute_groups_search` | Read group order and member labels |
| `attributes_profile_usage` | Inspect bounded value presence, types and observed options with explicit coverage limits |
| `families_inspect` | Combine family metadata and custom/system inheritance configuration, preserving partial failures |
| `products_inspect_inheritance` | Follow bounded product ancestry and compare reported levels, values and override markers |
| `asset_categories_search` | Read asset taxonomy paths and hierarchy when accessible |
| `server_capabilities` | Learn version choices, supported tools and public API gaps |

| Information | Public API contract |
| --- | --- |
| Product values and relationships | `GET /api/v2/products/{id}` and `POST /api/v2/products/search` |
| Available fields/operators/options | `GET /api/v1/filters/product`, `/filters/asset`, `/filters/relationships` |
| Attribute definitions | `POST /api/v1/attributes/product/search`, `GET /api/v1/attributes/product/{id}` |
| Attribute groups | `POST /api/v1/attribute-groups/product/search` |
| Families | `POST /api/v1/product_families/search`, `GET /api/v1/product_families/{id}` |
| Family inheritance | `GET /api/v1/product_families/{id}/attributes` or `/all_attributes` |
| Product category hierarchy | `POST /api/v1/categories/product/search` |
| Asset category hierarchy | `POST /api/v1/categories/file/search` |
| Assets and metadata | `POST /api/v1/assets/search`, `GET /api/v1/assets/{id}` |
| Relationship definitions | `POST /api/v1/relationships/search`, `GET /api/v1/relationships/{id}` |

Search requests should supply `filters: []` when unfiltered and explicitly request
the needed `attributes`. Otherwise some endpoints return IDs with little useful
context. Conditions inside a filter group are **AND**; groups are **OR**.
Sorting belongs in `pagination.order`, with a leading `-` for descending order.
Discover allowed operators for each field instead of assuming all operators apply.
`products_search.relationship_filters` supports OR-of-AND groups containing
`{relationship_id, operator: "exists" | "!exists"}`. All conditions must refer
to one relationship ID, obtained from `relationships_search`. This intentionally
small subset covers presence/absence; quantity constraints are not exposed yet.

Attribute projections include `name`, `label`, `type_class`, `groups`, `options`,
and `attributes`. For a CompletenessAttribute, the latter field contains member
objects with `id` and `label`; system members can have a null ID. Group projections
include `name`, `attribute_labels`, and `order`. Category projections include
`name`, `path`, `parents_ids`, `n_children`, and `order`.

Family attribute levels describe product inheritance configuration. Combine them
with product parent IDs and `overwritten_attributes` to investigate inheritance.
Identical parent/variant values alone do not establish inheritance. Attribute
purpose must be grounded in available metadata and actual usage; the public schema
does not guarantee a business-description field.

## Restricted metadata

Live checks confirmed that direct family detail and asset taxonomy search return
HTTP 403 with a permission-denied response for the current connection. The same
credentials can read other product, family and asset information.

- `families_get` recovers matching metadata through documented family search
  filtered by exact ID. Its `_retrieval` metadata states the source and that
  additional detail fields may be unavailable. `families_inspect` and
  `products_get_full` preserve this provenance and partial status. Other error
  statuses, mismatched IDs and empty results are not disguised as successful
  fallback data.
- `asset_categories_search` can fall back to IDs exposed by `assets_filters`.
  It returns `categories: null`, `partial: true`, a separate paged
  `available_category_ids` list, and explicit unapplied query/order flags.
  Names and hierarchy are still unavailable. These IDs are not claimed to be
  name-filtered taxonomy results or proof of a complete hierarchy.

[Plytix's permissions documentation](https://help.plytix.com/en/team-roles/permissions)
distinguishes ordinary asset View/Edit access from Asset Category settings,
which offer Edit/None. [API key roles](https://help.plytix.com/en/api) control API
access using those role permissions. This explains a possible cause; the exact
role assignments were not inspected or changed. Full taxonomy access requires
an owner review of the intended API role, not an undocumented endpoint.

## Mutation contracts

- Asset PATCH supports `filename`, `categories: [{id}]`, and `alt_text` up to
  512 characters. Filename extension changes are rejected.
- Linking an asset requires `attribute_label` as well as asset ID. Use
  `thumbnail` or an existing media/gallery attribute label. Single media linking
  replaces the existing value; gallery linking appends.
- V2 variant creation accepts `{sku, label?, attributes?}` directly; v1 uses a
  different `{variant: {...}}` wrapper. Do not mix their bodies.
- V2 relationship POST/PATCH use
  `{product_relationships: [{product_id, quantity}]}`. DELETE uses
  `{product_relationships: [product_id]}`. The API can silently ignore invalid
  or unrelated IDs and can return an empty successful response. Relationship
  tools report API acceptance separately from readback verification.
- Family attribute link/unlink bodies contain attribute **IDs**. Inheritance edit
  routes instead use labels; `/all_attributes/edit` prefixes custom labels with
  `attributes.`. Family inheritance updates may return `202 Accepted`, which
  acknowledges queued work rather than proving it completed.

These contracts are tested with fixtures. Live mutations require explicit
action-time approval, in addition to the server's write allowlist and host
approval provider.

## Public API gaps

The published collection does not document channel configurations, formula
definitions, channel processing/export operations, or product-list management
routes. Product records may include `static_list_ids`, and filter definitions may
expose static-list options. That is not a list-definition API or a route for
dynamic-list rules.

The server does not invent endpoints or use private browser APIs for these gaps.
`server_capabilities` explains the supported information and limits to connecting
agents. Future channel/formula tools should be based on newly documented endpoints
or a separately reviewed import/export contract.
