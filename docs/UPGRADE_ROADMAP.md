# TableR v0.1.5 Release Train

> Baseline: TableR v0.1.4b
>
> Target release: TableR v0.1.5
>
> Roadmap revision: 3.0
>
> Updated: 2026-07-18
>
> Delivery model: one public release train, twelve two-week sprints

## 1. Release Objective

TableR v0.1.5 must turn the current broad feature set into a dependable desktop database workspace. The release is not judged by feature count. It is judged by whether the main workflows are safe, predictable, recoverable, and testable on Windows, macOS, and Linux.

There is only one public version in this roadmap: `v0.1.5`.

- Sprint completions are internal checkpoints, not releases.
- CI artifacts use the commit SHA and are never marked `Latest`.
- `main` stays on the current stable release until the release candidate passes.
- The version is changed to `0.1.5` only in the release sprint.

## 2. Product Position

TableR v0.1.5 aims for professional parity with TablePro in the workflows that matter most:

1. Connect to a database and understand connection failures.
2. Browse schemas and large tables without stale or blank states.
3. Select, edit, paste, insert, delete, undo, and save rows safely.
4. Run, cancel, inspect, save, and restore SQL work.
5. Import and export large datasets without pretending a partial result is complete.
6. Perform supported schema and privilege operations with reviewable SQL.
7. Ask AI questions that use verified schema/data and link back to source rows.
8. Install, update, diagnose, and recover the desktop app consistently.

TableR does not need to copy every TablePro screen. It may claim an advantage only when the same task is measured with the same fixture and TableR has evidence for correctness, completion time, or recovery quality.

## 3. Release Scope

### Required for v0.1.5

- Capability-driven behavior for all declared engines; unsupported actions are blocked explicitly.
- Full edit/query/import/export reliability for PostgreSQL, MySQL/MariaDB, and SQLite.
- Browse/query/export smoke coverage for the remaining declared engines where CI credentials are available.
- Desktop E2E smoke coverage, structured redacted logs, and a reviewed diagnostic bundle.
- Stable grid selection, mutation identity, undo/redo, and persisted column layouts.
- Streaming import/export with progress, cancellation, cleanup, and clear row-error reporting.
- Unified query safety, cancellation, history, saved queries, and crash recovery.
- OS-backed secret storage and actionable connection-stage diagnostics.
- Capability-driven schema and user/role operations for PostgreSQL and MySQL/MariaDB.
- End-to-end AI streaming, grounded tools, source-row navigation, and an evaluation suite.
- ERD, chart, workspace, plugin, and MCP reliability work needed for the top workflows.
- Cross-platform installer, updater, migration, performance, accessibility, and release evidence.

### Conditional scope

These items enter a sprint only after its required work is accepted:

- SQL Server administration depth.
- SOCKS5 and one managed external tunnel vertical slice.
- Additional AI providers beyond the providers used by the evaluation lane.
- Additional Tier B/C engine integration coverage.

Conditional work cannot delay a required acceptance item in the same sprint.

### Explicitly deferred beyond v0.1.5

- Kerberos/SSPI enterprise authentication.
- Cloudflare Access and Cloud SQL Auth Proxy both being production-complete.
- Encrypted multi-device workspace sync and conflict resolution.
- A public third-party plugin marketplace.
- Full administration parity for all 19 engines.
- Apple notarization until signing credentials and budget exist.

Unsigned macOS artifacts may be published with accurate installation guidance. They do not count as trusted macOS distribution parity.

## 4. Capacity and Scheduling Rules

Planning assumptions:

- One primary engineer with AI-assisted implementation.
- Twelve two-week sprints from 2026-07-20 through 2027-01-03.
- A four-week stabilization buffer from 2027-01-04 through 2027-01-31.
- About 25 productive engineering hours per week after support and release work.
- At most one high-risk data, migration, or platform change active at a time.

Effort sizes:

| Size | Expected effort |
| --- | --- |
| S | 1-3 engineer-days |
| M | 4-6 engineer-days |
| L | 7-10 engineer-days |
| XL | Not allowed; split before commitment |

Sprint rules:

- Commit at most one L item plus one S item, or two M items.
- Keep no more than two implementation items in progress.
- P0/P1 production defects consume capacity before roadmap work.
- Unfinished required work moves forward; scope is removed before quality gates are weakened.
- A sprint is not complete because code exists. Tests, evidence, documentation, and recovery behavior are part of the work.

The sprint tables define the required release outcome, while commitment is based on remaining effort measured at sprint kickoff. Several capabilities already exist partially, so their listed size represents total technical risk rather than assumed greenfield effort. If the verified remainder exceeds the capacity rule, the sprint is split and every later date is reforecast; hidden overtime is not a scheduling strategy.

## 5. Status and Evidence

Allowed states:

- `Planned`: accepted, not started.
- `Active`: issue, branch, owner, and sprint exist.
- `Verification`: implementation is complete; evidence or review remains.
- `Done`: every acceptance criterion and required artifact passes.
- `Blocked`: external blocker, owner, workaround, and review date are recorded.
- `Dropped`: removal and product reason are recorded.

Every `Done` item requires:

- Tracking issue and reviewed PR/commit.
- Automated test report.
- Desktop E2E evidence for a critical workflow.
- Benchmark evidence for performance-sensitive work.
- Migration/security review where applicable.
- User documentation or release note.

## 6. Release Train Schedule

| Sprint | Dates | Theme | Required outcome |
| --- | --- | --- | --- |
| 1 | Jul 20-Aug 2 | Foundation closeout | Capability, threat, product baseline, and migration work accepted |
| 2 | Aug 3-Aug 16 | E2E and observability | Repeatable desktop smoke lane and privacy-safe diagnostics |
| 3 | Aug 17-Aug 30 | Grid correctness | Deterministic selection and safe row mutation |
| 4 | Aug 31-Sep 13 | Data movement | Streaming import/export vertical slice |
| 5 | Sep 14-Sep 27 | Query and editor | Unified execution, cancellation, history, and restore |
| 6 | Sep 28-Oct 11 | Connections and secrets | OS secrets, diagnostics, and reliable connection lifecycle |
| 7 | Oct 12-Oct 25 | Schema and administration | Reviewable, capability-driven DDL and privilege workflows |
| 8 | Oct 26-Nov 8 | AI runtime | True streaming, cancellation, privacy, and provider consistency |
| 9 | Nov 9-Nov 22 | Grounded agent | Verified tools, source-row links, charts, and evaluations |
| 10 | Nov 23-Dec 6 | Workspace and integrations | ERD/navigation reliability and plugin/MCP boundaries |
| 11 | Dec 7-Dec 20 | Product hardening | Performance, accessibility, migration, and cross-platform closure |
| 12 | Dec 21-Jan 3 | Release candidate | Clean-install matrix, parity review, release notes, and go/no-go |
| Buffer | Jan 4-Jan 31 | Stabilization only | P0/P1 fixes and failed gate remediation; no new features |

## 7. Sprint Backlog

### Sprint 1 - Foundation Closeout

Work already implemented in Sprint groups 0A and 0B is consolidated here for review; it is not reimplemented.

| ID | Size | Deliverable |
| --- | --- | --- |
| CAP-001 | L | Typed driver capability contract for all declared engines |
| CAP-002 | L | UI, AI, deep-link, and MCP actions enforced by backend capabilities |
| SEC-001 | M | Threat model for credentials, SQL, AI egress, MCP, plugins, updates, and storage |
| MIG-001 | M | Versioned persisted-state migration, backup, interruption recovery, and downgrade policy |
| PROD-001 | M | Primary persona, top ten workflows, fixtures, and TableR/TablePro baseline |

Acceptance:

- Every engine has explicit capability values; no implicit generic support remains.
- Unsupported actions are rejected at the backend boundary, not merely hidden.
- Object identity includes connection, database, schema, and object name.
- Upgrade, interrupted upgrade, corrupt state, and unsupported downgrade fixtures pass.
- Open review comments and CI failures for the existing 0A/0B work are resolved.

Exit evidence: [Sprint 0A evidence](roadmap/SPRINT_0A_EVIDENCE.md), [Sprint 0B evidence](roadmap/SPRINT_0B_EVIDENCE.md), capability matrix, threat model, migration recovery guide.

### Sprint 2 - E2E and Observability

| ID | Size | Deliverable |
| --- | --- | --- |
| TEST-001 | M | Documented desktop E2E framework decision and one-OS proof |
| TEST-002 | L | Launch, connect, query, and browse smoke tests with SQLite and PostgreSQL fixtures |
| OBS-001 | M | Structured redacted logs, operation IDs, and reviewed diagnostic export |

Acceptance:

- The production binary contains no E2E-only bridge or test capability.
- Failed runs retain driver logs, app logs, and screenshots.
- E2E fixtures are isolated from the user's profile and credentials.
- Passwords, tokens, AI keys, sensitive parameters, and connection URL secrets do not appear in logs.
- Diagnostic export previews its content and excludes connection secrets, query results, and AI content by default.

Exit evidence: [Sprint 0C evidence](roadmap/SPRINT_0C_EVIDENCE.md), E2E decision record, CI artifacts, redaction tests.

### Sprint 3 - Grid Correctness

| ID | Size | Deliverable |
| --- | --- | --- |
| GRID-001 | L | Canonical active-cell, rectangular range, row, and column selection model |
| DATA-001 | M | Stable row identity and no-primary-key mutation policy |
| GRID-002 | M | Command-based undo/redo for edit, paste, fill, insert, and delete |

Acceptance:

- Click, drag, Shift, Ctrl/Cmd, keyboard extension, select-all, and context-menu semantics are deterministic.
- Selection survives virtualization, fast scrolling, resize, sorting, and filtering.
- A multi-cell operation is one undo unit.
- Mutations are blocked when a row cannot be targeted unambiguously.
- PostgreSQL, MySQL/MariaDB, and SQLite mutation contract tests pass.

### Sprint 4 - Data Movement

| ID | Size | Deliverable |
| --- | --- | --- |
| GRID-003 | M | Scoped persisted column layouts: order, width, visibility, pinning, sort, and filter |
| IO-001 | L | Streaming CSV/TSV import with preview, mapping, validation, progress, and cancellation |
| IO-002 | L | Streaming CSV/JSONL export with atomic destination writes |

Scheduling rule: IO-001 is required. IO-002 starts only after the import slice is accepted; if both do not fit, export closure uses the first week of Sprint 5 and query scope is reduced before quality is reduced.

Acceptance:

- A generated 1 GB fixture does not cause memory growth proportional to file size.
- Rejected rows are downloadable with source row and reason.
- Transactional paths support Stop + Rollback.
- Full export never means only the loaded page.
- Cancelled or failed output is cleaned up or clearly marked incomplete.

### Sprint 5 - Query and Editor

| ID | Size | Deliverable |
| --- | --- | --- |
| QUERY-001 | L | Parser-backed classification shared by editor, AI, MCP, metrics, and administration |
| QUERY-002 | M | Standard cancellation, timeout, paging, warnings, affected rows, and transaction state |
| EDITOR-001 | M | Crash-safe unsaved editor restore, history, saved queries, and deterministic completion fixes |

Acceptance:

- All entry points reach the same safety decision for the same SQL.
- Cancellation cannot leave a stale success state or overwrite a newer result.
- Comment-only, selection, multi-statement, LIMIT/OFFSET, CTE, and alias fixtures pass per Tier A dialect.
- Restart restores SQL text, connection identity, database, tab, and cursor position.

### Sprint 6 - Connections and Secrets

| ID | Size | Deliverable |
| --- | --- | --- |
| CONN-001 | L | OS credential storage and safe migration of existing secrets |
| CONN-002 | M | Stage-aware connection diagnostics, timeout, cancellation, retry, and cleanup |
| CONN-003 | M | SOCKS5 vertical slice if required work finishes early |

Acceptance:

- Secrets do not appear in exported settings, logs, diagnostics, screenshots, or copied connection JSON.
- Diagnostics distinguish DNS, TCP, tunnel, TLS, authentication, and database-selection failures.
- Abandoned connection attempts release tasks, tunnels, and pooled resources.
- Clean-profile and v0.1.4b secret migration tests pass on all supported operating systems.

### Sprint 7 - Schema and Administration

| ID | Size | Deliverable |
| --- | --- | --- |
| ADMIN-001 | L | PostgreSQL and MySQL/MariaDB user, role, membership, and privilege model |
| SCHEMA-001 | L | Capability-driven create/alter/drop workflows with generated SQL preview |
| ADMIN-002 | S | Long-running operation status and targeted object refresh |

Acceptance:

- Unsupported privilege or DDL actions are disabled with a reason.
- Destructive SQL is previewed and reviewed before execution.
- Effective privileges are distinguished from direct grants.
- Partial failure preserves an accurate UI state and recovery path.
- Schema changes refresh only affected objects and invalidate stale editor/ERD metadata.

### Sprint 8 - AI Runtime

| ID | Size | Deliverable |
| --- | --- | --- |
| AI-001 | L | Provider-to-UI streaming with cancellation and bounded buffering |
| AI-002 | M | Provider-neutral event model for text, reasoning status, tools, usage, errors, and stop |
| AI-003 | M | Explicit data-egress policy and per-conversation live-data controls |

Acceptance:

- Tokens appear incrementally; the UI does not fake streaming from a completed answer.
- Stop acknowledgement meets the approved performance budget and no late chunks append afterward.
- Composer state clears correctly after send and cannot duplicate the user's message.
- Internal traces, raw tool payloads, SQL boilerplate, and model scratch text never leak into the final response.
- Live data access is visible, scoped, revocable, and covered by redaction tests.

### Sprint 9 - Grounded Agent

| ID | Size | Deliverable |
| --- | --- | --- |
| AGENT-001 | L | Schema-first browse, search, aggregate, and sample tools using verified identifiers |
| AGENT-002 | M | Source citations that open the correct table and focus the matching row |
| AGENT-003 | M | Reproducible chart specification generated from verified query output |
| EVAL-001 | M | Versioned agent evaluation set with accuracy, safety, latency, and tool-use scoring |

Acceptance:

- The agent discovers real columns before generating a filter or query.
- Read permission authorizes safe read tools; it does not encourage guessed column names.
- Row links include qualified object identity and stable row identity or an explicit non-navigable reason.
- A chart records source query, selected dimensions/measures, transforms, and limits.
- Greetings and non-data questions do not trigger unnecessary schema scans or SQL.
- Evaluation thresholds are fixed before the release candidate is run.

### Sprint 10 - Workspace and Integrations

| ID | Size | Deliverable |
| --- | --- | --- |
| WORK-001 | M | Qualified favorites, recents, quick switcher, and reliable tab/workspace restore |
| ERD-001 | M | Large-schema layout, search, selection, minimap, and metadata refresh reliability |
| EXT-001 | L | Plugin and MCP permission, timeout, cancellation, redaction, and revocation contract |

Acceptance:

- Navigation never opens the same-named object from the wrong connection/schema.
- Workspace restore does not duplicate expensive resources or resurrect closed sensitive tabs.
- ERD remains usable with the approved large-schema fixture and does not render blank after fast interaction.
- Plugins and MCP cannot bypass query safety, capabilities, or live-data consent.
- Malformed, oversized, timed-out, and revoked requests fail closed.

### Sprint 11 - Product Hardening

| ID | Size | Deliverable |
| --- | --- | --- |
| PERF-001 | M | Reproducible launch, memory, grid, editor, cancellation, and data-movement benchmarks |
| A11Y-001 | M | Keyboard, focus, contrast, viewport, and reduced-motion closure for critical workflows |
| MIG-002 | M | Full v0.1.4b to v0.1.5 upgrade, interruption, recovery, and downgrade drill |
| REL-001 | M | Windows, macOS, and Linux installer/updater smoke matrix |

Acceptance:

- No unexplained regression above 15% in a binding benchmark.
- Critical workflows are keyboard-complete and pass automated accessibility checks.
- Migration failure restores a usable backup or gives exact recovery instructions.
- Clean install, upgrade, uninstall, first launch, and diagnostics pass on supported OS versions.
- Unsigned macOS behavior and override instructions are verified on a clean Sonoma-or-newer machine.

### Sprint 12 - Release Candidate

| ID | Size | Deliverable |
| --- | --- | --- |
| PARITY-001 | M | Evidence-based TableR/TablePro comparison on the top workflows |
| SEC-002 | M | Dependency, secret, permission, SBOM, and accepted-risk review |
| REL-002 | L | Release contract, notes, website/download metadata, updater manifest, and signed checksums |

Acceptance:

- Every required release gate in Section 9 is `Pass` with evidence.
- No open P0 or P1 defect remains; accepted P2 defects have an owner and user-visible workaround.
- Version matches across package, Tauri, Cargo, website, updater metadata, release title, and tag.
- Release assets are smoke-tested after download, not only in the build workspace.
- GitHub release is published, non-draft, non-prerelease, and marked `Latest` only after asset verification.

## 8. Engineering Policies

### Data safety

- Mutations require stable identity, explicit transaction behavior, accurate affected-row counts, and recovery after partial failure.
- Destructive schema/administration actions show generated SQL and impact before execution.
- Import/export never conflates preview, loaded page, filtered set, and complete dataset.

### Security and privacy

- Secrets belong in OS credential storage, not application JSON.
- Logs are structured and useful without recording secrets or raw sensitive values.
- AI receives schema, samples, or query results only under visible live-data consent.
- Plugins and MCP use the same capabilities and safety checks as the first-party UI.

### Architecture

- No big-bang rewrite of DataGrid, AI workspace, ERD, or the shared stylesheet.
- Extract modules as part of tested vertical slices.
- New production modules above 600 lines require a review note; above 1,000 lines require an approved exception.
- Domain state and backend contracts must not depend on presentation components.

### Testing

- PR lane target: 15 minutes; typecheck, lint, frontend tests/build, Rust format/Clippy/tests, affected integration tests.
- Nightly lane: complete suites, Tier A matrix, selected other-engine smoke, benchmarks, dependency and secret scans.
- Release lane: desktop E2E, install/update/migration, screenshots, accessibility, security, and manual exploratory evidence on three OSes.
- No blind retries. A quarantined flaky test needs an issue, owner, reason, and seven-day expiry.

## 9. Release Gates

Every required row must be `Pass`. `Partial` is a no-go.

| Gate | Required evidence | Status |
| --- | --- | --- |
| Capability safety | Generated engine matrix and backend enforcement tests | Verification |
| Persisted-state recovery | Migration fixtures and v0.1.4b upgrade drill | Verification |
| Desktop E2E | SQLite/PostgreSQL launch-connect-query-browse artifacts | Verification |
| Observability/privacy | Redaction tests and reviewed diagnostic sample | Verification |
| Grid/data safety | Selection, undo/redo, stable mutation identity E2E | Planned |
| Import/export | 1 GB memory, rollback, cancellation, and round-trip report | Planned |
| Query/editor | Shared execution, cancellation, completion, and crash restore tests | Planned |
| Connections/secrets | OS secret migration and staged failure-injection report | Planned |
| Schema/admin | PostgreSQL/MySQL privilege and DDL integration fixtures | Planned |
| AI | Streaming, privacy, grounded-tool, row-link, and evaluation report | Planned |
| Workspace/extensions | Navigation identity, ERD, plugin, and MCP abuse tests | Planned |
| Accessibility | Keyboard and critical-screen audit | Planned |
| Performance | Reproducible baseline and regression report | Planned |
| Cross-platform release | Clean install/update/uninstall and downloaded-asset smoke | Planned |
| Product parity | Top-workflow TableR/TablePro comparison | Planned |

## 10. Go/No-Go Rules

Publish v0.1.5 only when:

- All required gates are `Pass` with links to immutable evidence.
- No P0/P1 defect is open.
- Data-loss, wrong-row mutation, secret leakage, unsafe AI egress, migration failure, and updater failure scenarios pass.
- Windows, macOS, and Linux release artifacts are present and verified, with the macOS signing exception stated accurately.
- The release contract confirms one version and one commit across every distribution surface.

The release is delayed when a required gate fails. A gate may not be waived by relabeling required scope as conditional during Sprint 12.

## 11. Current Board

| ID | Status | Sprint | Evidence / next action |
| --- | --- | --- | --- |
| ROAD-001 | Verification | 1 | Roadmap revision 3.0; final review required |
| CAP-001 | Verification | 1 | [Sprint 0A evidence](roadmap/SPRINT_0A_EVIDENCE.md) |
| SEC-001 | Verification | 1 | [Threat model](security/THREAT_MODEL.md) |
| PROD-001 | Verification | 1 | [Workflow baseline](product/PROFESSIONAL_WORKFLOW_BASELINE.md) |
| CAP-002 | Verification | 1 | [Sprint 0B evidence](roadmap/SPRINT_0B_EVIDENCE.md) |
| MIG-001 | Verification | 1 | [Recovery guide](operations/STORAGE_RECOVERY.md) |
| TEST-001 | Done | 2 | [Sprint 2 evidence](roadmap/SPRINT_0C_EVIDENCE.md), [PR #70](https://github.com/minhe51805/TabLer/pull/70); feature-gated desktop E2E and production exclusion verified |
| TEST-002 | Done | 2 | [Desktop E2E run](https://github.com/minhe51805/TabLer/actions/runs/29647545143); SQLite and PostgreSQL production-command smoke pass |
| OBS-001 | Done | 2 | [Sprint 2 evidence](roadmap/SPRINT_0C_EVIDENCE.md); structured redaction, artifact privacy, operation IDs, and reviewed diagnostic export pass |

## 12. Immediate Execution Order

1. Resolve review and CI evidence for Sprint 1, then mark accepted items `Done`.
2. Merge the Sprint 1 parent stack, rebase PR #70 onto `develop`, and merge the accepted Sprint 2 scope.
3. Record baseline startup, memory, schema-load, grid-scroll, cancellation, and import measurements before Sprint 3 changes behavior.
4. Create Sprint 3 issues only after the Foundation gate passes.
5. Reforecast dates and conditional scope at the end of every second sprint.

No new database engine, cloud sync work, public plugin marketplace, or unrelated redesign enters the v0.1.5 train before the required release gates pass.
