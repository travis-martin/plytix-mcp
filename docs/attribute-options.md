# Attribute option cleanup

`attributes_update_options` sets manual order for existing DropdownAttribute and
MultiSelectAttribute options. It can add explicitly reviewed new options and remove
unused ones. It cannot edit product values or other attribute settings; it does not
rename or normalize existing product values.

Read `attributes_get` first. Pass its ID, exact label, modified timestamp, complete
current `options` as `expected_options`, and the complete retained list in the
desired order as `options`. Include every newly introduced value in `add_options`;
that explicit list must exactly match the new values in `options`. Omitting it
retains cleanup-only behavior. All lists require unique, nonempty strings;
`expected_options` may be empty to initialize an existing empty definition, while
the final `options` list must contain at least one value. Full approval snapshots
are compacted without truncation within a 64,000-character limit. Keep usage
auditing and semantic grouping in the calling workflow.

The tool is hidden by default. An operator must explicitly include
`attributes_update_options` in `PLYTIX_WRITE_TOOLS`; the existing form or trusted
host approval policy still applies. The shared stdio/HTTP API policy permits only
PATCH of the selected attribute route, not product updates or attribute deletion.

After approval, the tool:

1. Reads the definition without using a cached copy and rejects stale review data.
2. Checks the entire removal set with an unfiltered catalog-wide product `in`
   search. It requires `pagination.count === 0` and an empty result list; missing
   counts or any product match block the write. It does not use `total_count` as
   the filtered count.
3. Reads the definition again without caching and rejects concurrent changes.
4. Sends one PATCH containing only `options` and `manual_sorting: true`.
5. Reads back the saved definition without caching, verifies exact order and
   preserved settings, and invalidates the label lookup cache.

An already matching manual order is a verified no-op. A failed or ambiguous write
is not retried and returns `write_attempted` / `requires_inspection`; inspect live
state before further action. Callers should save the original definition first.
The public API does not provide a transactional lock across the usage search and
attribute PATCH: coordinate with imports and other writers. Preflight and readback
reduce risk but do not establish atomicity or prove unchanged product records.

Official references, checked November 5, 2026:

- [Update a product attribute](https://docs.plytix.com/reference/v1-v2/product-attributes/update-product-attribute/): `options` replaces existing options.
- [Option sorting](https://docs.plytix.com/reference/v1-v2/product-attributes/create-product-attribute/): manual order follows the options array.
- [Removing options](https://help.plytix.com/en/create-and-manage-product-attributes): deleting an option also removes it from products using it.
