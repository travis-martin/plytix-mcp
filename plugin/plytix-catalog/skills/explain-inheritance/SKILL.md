---
{"name":"explain-inheritance","description":"Use when explaining Plytix parent and variant attribute values, family inheritance levels, overrides, or the effects of a proposed attribute update."}
---

# Explain product inheritance

Resolve the product without hiding ambiguous matches. Retrieve current family configuration using `families_inspect` and product evidence using `products_inspect_inheritance`. Request only the attributes and relationships needed to answer the question.

For each attribute explain its configured inheritance level, the product carrying the effective value, any explicit override, and whether that conclusion is complete or limited by unavailable evidence. Equal parent and child values do not establish inheritance.

Before proposing a write, identify the actual target record and affected descendants. Do not create a variant override or clear an existing override implicitly. Treat unknown inheritance, incomplete ancestry, and unreviewed descendant impact as blockers for updates. Family reassignment and inheritance resets require their own exact review; they are not ordinary pricing changes.

Present current and proposed values with the supporting family/ancestry evidence. Refresh live values immediately before an approved update and read them back afterward. Store any newly learned family or attribute rule as proposed context until reviewed.
