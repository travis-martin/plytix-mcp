# Changelog

Release entries follow [Change Record Standard v1](docs/change-history.md).
The Git history remains authoritative for individual source changes. Organization
knowledge has its own committed revision archive and private export lineage.

## Unreleased

### Added

- Optional Windows TPM-backed service-account authentication for native remote
  connectors and the local review panel, independent of personal Google sessions.
- Bounded automatic Google ID-token exchange, hardware-key validation and a public
  certificate provisioner with partial-progress records and no private-key export.
- A standalone, content-addressed authentication helper that can be pinned outside
  the working checkout and selected with machine-only `helper_path` metadata.

### Fixed

- Clean Windows PowerShell provisioning loads its own certificate provider and
  passes local-time certificate dates to CertEnroll while retaining UTC records.
- Provisioning failures retain sanitized stage/category/HRESULT diagnostics.

Change-Id: change-20261118-connector-machine-auth
Reason: Remove recurring human Google reauthentication from unattended connector access.
Sources: approved production authentication request; docs/machine-authentication.md
Validation: Typecheck/build, all 647 fixtures with one worker, 3 change-record tests and plugin validation/isolated startup passed. Approved TPM identity, pinned connector and rejected-token renewal were verified live without personal Google credentials or product writes.
Rollback: Forward-revert code/docs and restore the previous native profile; review credential revocation separately.

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

### Fixed

- Server and workspace release labels match the package version; the isolated
  plugin check now verifies the server handshake version before activation.

Change-Id: change-20261118-chemcast-knowledge-history
Reason: Make pricing audits proposal-only and retain consistent evidence for knowledge changes and rollback.
Sources: approved knowledge maintenance and history request; docs/change-history.md
Validation: Typecheck/build, 563 fixture tests (one worker), 3 change-record tests, plugin validation/isolated startup and container smoke passed. Source calculations reproduced all 260 reviewed owners offline; no product writes.
Rollback: Forward Git revert for code/docs; reviewed new revisions for knowledge/rules. Upgrade all readers before new-format saves.
