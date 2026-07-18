# Sprint 0B Evidence

> Sprint group: 0B
> Branch: `feature/sprint-0b-capabilities-migrations`
> Tracking issue: [#67](https://github.com/minhe51805/TabLer/issues/67)
> Updated: 2026-07-18
> Decision: Verification

## Work Items

| ID | Evidence | Status |
| --- | --- | --- |
| CAP-002 | Backend command guards, active-connection capability command, capability-driven grid/admin/schema/export UI, canonical object identity, Rust and UI tests | Verification |
| MIG-001 | Startup migration journal, atomic manifest, pre-migration snapshot, interrupted-run recovery, four failure fixtures, recovery guide | Verification |

## Verification Results

| Check | Result |
| --- | --- |
| Migration fixtures | Passed; 4 passed, 0 failed |
| Capability catalog tests | Passed; 4 passed, 0 failed |
| Active connection capability lifecycle | Passed; 1 passed, 0 failed |
| Rust library suite | Passed; 112 passed, 0 failed, 2 service-dependent tests ignored |
| Rust formatting | Passed with `cargo fmt --check` |
| Frontend typecheck and production build | Passed |
| Frontend test suite | Passed; 64 files and 291 tests |
| Frontend lint | Passed with 61 baseline warnings and 0 errors (configured maximum: 64 warnings) |
| Strict Clippy | Blocked by 20 pre-existing `-D warnings` findings outside Sprint 0B; no Sprint 0B finding was reported |

## Acceptance Audit

| Criterion | Evidence assessment |
| --- | --- |
| Unsupported actions cannot bypass UI through agent/MCP/internal calls | Backend command boundaries enforce query, parameter, edit, atomic queue/import, schema, export/restore, and administration capabilities. AI and MCP execute through these commands. Deep links do not execute database commands directly. |
| Visible controls consume the capability contract | DataGrid import/edit/export, schema creation, database export, and Users & Roles are capability-driven and fail closed while capability state is unavailable. |
| Same-named objects have complete identity | Cache keys serialize connection, database, schema, and object components; delimiter-collision and same-name tests are included. |
| Migration failure modes are covered | Upgrade, interrupted upgrade, corrupt manifest, and unsupported downgrade fixtures pass. |

## Remaining Before Done

- Pass the complete Rust and frontend suites in CI.
- Complete code review and a manual Tier A UI check.
- Record the tracking issue and pull request after publication.
- Resolve or formally baseline the repository-wide strict-Clippy debt in its own quality item.
