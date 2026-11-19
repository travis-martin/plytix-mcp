# Changelog

Release entries follow [Change Record Standard v1](docs/change-history.md).
The Git history remains authoritative for individual source changes. Organization
knowledge has its own committed revision archive and private export lineage.

## 0.16.0 — 2026-11-18

### Added

- Dedicated owner-only pricing audit with proposal-only learning and no product
  writes or persistent import/plan/dictionary records.
- Retained immutable knowledge/rule revision archives and reviewed rollback
  preparation without erasing intervening history.
- Platform-independent change-record standard, commit template, local validation
  hook and CI checks for future commits.

### Changed

- Deliberate knowledge/rule saves require source and reason metadata; automatic
  observations remain distinctly attributed.
- Source price parsing preserves up to 18 fractional digits for final full-item
  cost calculation, while mutation amounts retain existing limits.
- Pricing guidance documents source category, precision, independent size lists,
  table-specific units and owner-only audit limits.

Change-Id: change-20261118-chemcast-knowledge-history
Reason: Make pricing audits proposal-only and retain consistent evidence for knowledge changes and rollback.
Sources: approved knowledge maintenance and history request; docs/change-history.md
Validation: Typecheck/build, 563 fixture tests (one worker), 3 change-record tests, plugin validation/isolated startup and container smoke passed. Source calculations reproduced all 260 reviewed owners offline; no product writes.
Rollback: Forward Git revert for code/docs; reviewed new revisions for knowledge/rules. Upgrade all readers before new-format saves.
