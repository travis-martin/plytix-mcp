---
{"name":"audit-product-quality","description":"Use when auditing Plytix product completeness, allowed values, identifier ambiguity, asset metadata, or consistency across a bounded product population."}
---

# Audit product quality

Agree on the product population, required attributes, and business criteria from the user's task and confirmed catalog definitions. Discover schema, valid filter operators, family applicability, option values, and data types before evaluating records.

Use explicit projections and bounded pagination. `attributes_profile_usage` describes a sample; do not report its percentages as account-wide results unless coverage proves that claim. A completeness score alone does not prove business quality.

Report each finding with product ID/SKU, family, attribute label, observed value, violated criterion, evidence timestamp, and suggested correction. Distinguish unknown or inaccessible evidence from a failing value. Use `products_inspect_inheritance` before recommending changes to an inherited attribute.

Finish with counts of inspected, passing, failing, blocked, and uninspected records. Keep proposed changes separate from actual changes. Exact write approval and current-value verification are required before any correction. Preserve new business rules as proposed, evidence-backed learning until separately reviewed.
