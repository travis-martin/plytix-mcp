# API coverage and version decisions

Reviewed against the [official Plytix API reference](https://apidocs.plytix.com/)
on October 20, 2026. The reference's
[published Postman collection](https://apidocs.plytix.com/api/collections/42465620/2sBYB2qSYS?segregateAuth=true&versionTag=latest)
is the source of the route and request contracts below. These are documentation
checks, not evidence that a particular account can execute every operation.

## Versions

Plytix still labels the product v2 API **open beta**. This server uses v2 for
documented product operations and v1 for schema, families, relationships,
categories, and account assets. Variant listing uses the documented
`GET /api/v1/products/{id}/variants`; the current v2 reference does not define a
corresponding GET route. There is no justified blanket upgrade of all paths to v2.

Product v2 reads can return asset/category IDs instead of hydrated objects.
`products_get_full`, `assets_list`, and `categories_list` retrieve related data
separately. V2 create/update responses may contain only IDs and audit timestamps;
they are not full product snapshots.

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
