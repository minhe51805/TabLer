# TableR Execution Roadmap

> Product baseline: TableR v0.1.4b
> Roadmap revision: 2.1
> Updated: 2026-07-18
> Planning horizon: 2026-07-20 to 2028-04-23, followed by stabilization buffer
> Scope: Windows, macOS, and Linux desktop database client

## 1. Purpose

This document is the execution plan for turning TableR into a dependable professional database workspace.

It is not a feature wish list. Every committed item has:

- A stable work-item ID.
- A role owner.
- An effort estimate.
- Explicit dependencies.
- Verifiable acceptance criteria.
- A required exit artifact.

TableR will pursue parity with TablePro in database-client fundamentals and differentiate through grounded AI, visualization, ER diagrams, and consistent cross-platform delivery.

## 2. Planning Assumptions

The initial schedule assumes:

- One primary engineer with AI-assisted implementation.
- 25 productive engineering hours per week after support and release work.
- Two-week sprints.
- At most one high-risk platform change active at a time.
- A program buffer of approximately 20% for driver differences, CI instability, and release defects.
- No Apple signing/notarization credentials during the initial plan.

Effort notation:

| Size | Expected effort | Rule |
| --- | --- | --- |
| S | 1-3 engineer-days | Safe for one sprint with other work |
| M | 4-6 engineer-days | Usually one primary sprint deliverable |
| L | 7-10 engineer-days | Must occupy a sprint by itself |
| XL | More than 10 engineer-days | Forbidden; split before commitment |

Schedule rules:

- A sprint may commit at most one L item, one M plus one S item, or two M items.
- Production support and P0 defects take capacity before roadmap work.
- Dates are reforecast at every internal phase-gate review.
- Existing code does not make a work item `Active`; work starts only when an issue and branch exist.

## 3. Success Definition

### Professional baseline

TableR is professionally dependable when:

- Grid edits, imports, exports, queries, and schema changes cannot silently lose or target the wrong data.
- Unsupported operations are blocked by backend capability contracts before reaching the UI or agent.
- Critical desktop workflows have automated regression coverage.
- Persisted state has versioned migrations and recovery behavior.
- Secrets and database data have explicit security and AI-egress policies.

### TablePro parity

Parity means comparable workflow depth, not matching every screen or counting visible features.

The parity release must pass the matrix in Section 12 for:

- Data grid.
- Import/export.
- SQL editor and execution.
- Connection reliability and enterprise network paths.
- Users, roles, schema, and server operations.
- Multi-window/split workspace and navigation.
- Plugin/MCP safety.
- Installation, update, recovery, and cross-platform regression quality.

### TableR differentiation

Claims of being stronger than TablePro are permitted only for individually measured workflows:

- Grounded agent answers with source-row navigation.
- Reproducible AI-generated charts and metrics.
- ERD and schema-impact analysis.
- Verified breadth across SQL, NoSQL, and cloud-native engines.
- Consistent Windows, macOS, and Linux workflows.

## 4. Baseline Inventory

TableR currently defines 19 database engines:

- PostgreSQL, MySQL, MariaDB, SQLite.
- SQL Server, DuckDB, CockroachDB, ClickHouse, Redis, MongoDB.
- BigQuery, Snowflake, Cassandra, Redshift, Greenplum, Vertica, LibSQL, Cloudflare D1, OpenSearch.

Existing product foundations include:

- Tauri 2 and Rust backend.
- Monaco SQL editor with dialect completion, schema context, CTE/alias support, Vim mode, and AI completion.
- Virtualized editable grid with filtering, sorting, row selection, paste/import, and change tracking.
- ER diagrams, charts, metrics boards, query plans, terminal, plugins, MCP, deep links, and AI workspace.
- Safe-mode checks and reviewed SQL paths.

Audited weaknesses:

- Driver capability depth is inconsistent.
- Grid selection and persisted column layouts are incomplete.
- CSV preview reads the full file and is limited to 50 MB.
- AI provider responses are not streamed end to end.
- Users & Roles covers only basic actions on three engines.
- Enterprise proxy, tunnel, and Kerberos workflows are absent.
- No complete desktop E2E suite exists.
- Persisted-state migrations and security controls are not managed as dedicated workstreams.
- Several frontend modules and the shared stylesheet are too large to change safely.
- macOS artifacts remain unsigned until credentials become available.

## 5. Database Support Contract

Support is capability-based. Each engine receives one of four values for every capability:

- `Required`: mandatory for the engine's tier.
- `Optional`: supported only when implemented and tested.
- `Not applicable`: meaningless for that engine, such as SSH on a local SQLite file.
- `Unsupported`: deliberately unavailable and explained before use.

### Tier A: Core

Engines: PostgreSQL, MySQL, MariaDB, SQLite.

Tier A requires all applicable capabilities for connection, schema discovery, query execution, cancellation, paging, editing, transactions, import, export, schema operations, backup/restore, and regression testing.

### Tier B: Extended

Engines: SQL Server, DuckDB, CockroachDB, ClickHouse, Redis, MongoDB.

Tier B requires reliable connection, browse, query, paging, export, and visualization. Editing and administration are enabled only through tested optional capabilities.

### Tier C: Specialized

Engines: BigQuery, Snowflake, Cassandra, Redshift, Greenplum, Vertica, LibSQL, Cloudflare D1, OpenSearch.

Tier C requires connection, query, schema browsing, export smoke coverage, explicit limitations, and no misleading generic actions.

An engine changes tier only through a release review backed by capability-contract tests.

## 6. Status and Evidence

Allowed statuses:

- `Planned`: accepted in the roadmap but no implementation branch exists.
- `Active`: issue, branch, owner, and current sprint are recorded.
- `Verification`: implementation is complete; acceptance evidence is being collected.
- `Done`: all acceptance criteria and exit artifacts pass.
- `Blocked`: external dependency, owner, and next review date are recorded.
- `Dropped`: removal is documented with a product reason.

Every `Done` item must link to:

- Tracking issue.
- Pull request or commit.
- Automated test report.
- Benchmark report when performance-sensitive.
- Migration/security review when applicable.
- Release note or user documentation.

## 7. Release Train

There is one public release train and one final version target:

| Release | Development window | Outcome | Final decision |
| --- | --- | --- | --- |
| v0.1.5 Complete Update | 2026-07-20 to 2028-04-23 | Foundation, data workflow, query/connectivity, administration/AI, workspace/integrations, and parity stabilization | Publish only when every required gate in Section 12 passes |

Internal checkpoints do not create public versions or GitHub releases:

| Phase | Target window | Sprint groups | Internal gate |
| --- | --- | --- | --- |
| Phase 0 - Foundation | 2026-07-20 to 2026-09-13 | 0A-0C | Core contracts, threat model, migrations, observability, and E2E foundation accepted |
| Phase 1 - Data Workflow | 2026-09-14 to 2026-11-22 | 1A-1E | Tier A grid and streaming data workflows accepted |
| Phase 2 - Query and Connectivity | 2026-11-23 to 2027-03-14 | 2A-2H | Query, editor, credential, and initial enterprise paths accepted |
| Phase 3 - Administration and AI | 2027-03-15 to 2027-09-12 | 3A-3M | Enterprise closure, administration, schema/server, and grounded AI accepted |
| Phase 4 - Workspace and Integrations | 2027-09-13 to 2028-01-30 | 4A-4I | Multi-window, sync, Plugin SDK, and MCP accepted |
| Phase 5 - Parity Stabilization | 2028-01-31 to 2028-04-23 | 5A-5F | Cross-platform, migration, performance, release, and product parity accepted |
| Contingency buffer | 2028-04-24 to 2028-06-25 | As required | P0/P1 parity blockers only; no new feature scope |

During development, CI may publish commit-addressed nightly or internal artifacts. They must not be marked `Latest`, must not use a public semantic version tag, and must not be presented as a stable release.

Dates are targets, not promises. v0.1.5 slips instead of waiving data-safety, security, migration, or parity gates.

### Branch and version policy

- Each sprint item uses a short-lived `feature/...`, `fix/...`, or `refactor/...` branch and a tracking issue.
- Reviewed sprint work merges into `develop`; no phase is implemented on one long-lived feature branch.
- Phase gates run against `develop` and produce commit-addressed internal artifacts only.
- `main` remains the stable public line until the final release candidate is approved.
- After the Phase 5 go decision, create `release/v0.1.5` from `develop`, run the complete release-candidate lane, merge to `main`, and tag `v0.1.5`.
- `package.json`, Tauri configuration, website release data, updater metadata, and release notes change to v0.1.5 together through the release-contract check.
- Critical production hotfixes for the existing stable version may branch from `main`; they do not add feature scope to this train.

## 8. Executable Backlog

The sections below are sprint groups. A group can contain multiple sequential two-week sprints when it lists more than one L item. Items are pulled according to the capacity rules in Section 2; they are never assumed to run in parallel for the one-engineer plan. A sprint group closes only when all of its items and exit artifacts are complete.

Owner roles:

- `CORE`: Rust drivers, query execution, import/export, migrations.
- `UI`: React workspace, grid, editor, accessibility.
- `AI`: provider transport, agent tools, evaluations.
- `SEC`: credentials, threat modeling, plugin/MCP policy.
- `REL`: CI, E2E, packaging, updater, documentation.

For a one-engineer plan, roles indicate review perspective and code ownership boundary rather than separate people.

### Phase 0 - Foundation

#### Sprint group 0A - Capability and risk baseline

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| CAP-001 | CORE | L | None | Typed `DriverCapabilities` contract for all 19 engines |
| SEC-001 | SEC | M | None | Threat model covering credentials, SQL execution, AI egress, MCP, plugins, updates, and local storage |
| PROD-001 | REL | M | None | Primary user definition, top professional workflows, and baseline TableR/TablePro task comparison |
| ROAD-001 | REL | S | None | Roadmap status/evidence template and release review checklist |

Acceptance:

- Capability fields cover connect, cancel, parameters, paging, edit, transaction, import, export, explain, schema edit, backup/restore, and administration.
- All engines compile with explicit values; no implicit support defaults remain.
- Threat model records assets, trust boundaries, threats, mitigations, and accepted risks.
- Product baseline names the primary user, test dataset, top ten tasks, observed failure points, and measurable success criteria.
- UI behavior is unchanged in this sprint.

Exit artifacts: generated capability JSON, threat-model document, contract unit tests, product-workflow baseline.

#### Sprint group 0B - Capability-driven UI and migrations

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| CAP-002 | UI/CORE | L | CAP-001 | Grid, toolbar, admin, and agent actions consume the capability contract |
| MIG-001 | CORE | M | None | Versioned persisted-state migration framework with backup and failure recovery |

Acceptance:

- Unsupported actions cannot be triggered through UI events, deep links, AI, or MCP.
- Same-named objects are identified by connection, database, schema, and object name.
- Migration fixtures cover upgrade, interrupted upgrade, corrupt state, and unsupported downgrade.

Exit artifacts: capability UI tests, migration fixtures, recovery documentation.

#### Sprint group 0C - E2E and observability foundation

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| TEST-001 | REL | M | None | Time-boxed spike selecting and proving a desktop E2E path on one OS |
| TEST-002 | REL | L | TEST-001 | Launch/connect/query/browse smoke suite using PostgreSQL and SQLite fixtures |
| OBS-001 | CORE | M | SEC-001 | Structured redacted logs, operation IDs, and diagnostic bundle export |

Acceptance:

- The spike records rejected options and platform limitations before framework commitment.
- Failed E2E runs retain logs and screenshots.
- Logs contain no passwords, tokens, SQL parameters marked sensitive, or AI keys.
- Diagnostic bundles require user review before export.

Exit artifacts: E2E decision record, smoke artifacts, redaction tests.

#### Phase 0 gate

- CAP-001, CAP-002, MIG-001, SEC-001, PROD-001, TEST-001, TEST-002, and OBS-001 are `Done`.
- Tier A capability gaps are assigned to later v0.1.5 sprint groups, not hidden.
- Baseline startup, memory, schema-load, grid-scroll, query-cancel, and import measurements are published.

### Phase 1 - Data Workflow

#### Sprint group 1A - Grid selection

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| GRID-001 | UI | L | TEST-002 | Canonical active-cell, rectangular-range, row, and column selection model |
| PERF-001 | REL | S | TEST-002 | Reference hardware, datasets, measurement scripts, and variance policy |

Acceptance:

- Click, drag, Shift, Ctrl/Cmd, keyboard extension, select-all, and right-click semantics are deterministic.
- Selection survives virtualization, scrolling, resize, and context-menu opening.
- Clipboard output exactly matches visual row and column order.

Exit artifacts: selection state-machine tests, E2E interaction recording, baseline benchmark.

#### Sprint group 1B - Unified edit history

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| GRID-002 | UI/CORE | L | GRID-001, CAP-002 | Command-based undo/redo for edits, paste, fill, insert, and delete |
| DATA-001 | CORE | S | CAP-001 | Stable-row identity and no-primary-key mutation policy |

Acceptance:

- A multi-cell operation is one undo unit.
- Undo/redo restores data, pending commands, and selection.
- Destructive mutation is blocked when a row cannot be targeted safely.
- Transaction failure leaves database and UI in a documented state.

Exit artifacts: mutation contract tests, Tier A integration tests, recovery-state screenshots.

#### Sprint group 1C - Column layouts

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| GRID-003 | UI | L | MIG-001, GRID-001 | Hide, reorder, pin, resize, autosize, reset, and persisted table layouts |
| UI-001 | UI | S | None | Extract only grid styles/components touched by GRID-001 through GRID-003 |

Acceptance:

- Layout identity includes connection, database, schema, and table.
- Width, order, visibility, pinning, sort, and filter survive restart.
- Hidden columns remain hidden during resize and initial load.
- Migration and reset behavior are tested.

Exit artifacts: layout migration fixture, screenshot matrix, persisted-state tests.

#### Sprint groups 1D-1E - Streaming import/export vertical slices

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| IO-001 | CORE | L | CAP-001, PERF-001 | Rust streaming CSV/TSV preview and PostgreSQL/SQLite import path |
| IO-002 | CORE | L | CAP-001, PERF-001 | Streaming CSV/JSONL export with atomic destination writes |

Scheduling note: IO-001 and IO-002 occupy separate sprints for a one-engineer team. If IO-002 cannot finish in Phase 1, the Phase 1 gate remains open and later work cannot claim complete data-movement parity.

Acceptance:

- A generated 1 GB fixture is processed without memory growing linearly with file size.
- Import supports sample preview, mapping, validation, progress, cancellation, and rejected-row output.
- Transactional paths test Stop + Rollback; other modes are enabled only by capability.
- Full export never silently means loaded-page export.
- Cancelled/failed export is not presented as complete.

Exit artifacts: benchmark report, round-trip fixtures, cancellation and cleanup tests.

#### Phase 1 gate

- GRID-001 through GRID-003 and DATA-001 are `Done`.
- Tier A edit integration tests pass.
- IO-001 and IO-002 pass PostgreSQL and SQLite vertical slices; MySQL/MariaDB completion is explicitly tracked if unfinished.
- No P0 grid selection, wrong-row mutation, import rollback, or incomplete-export defect remains.

### Phase 2 - Query and Connectivity

#### Sprint groups 2A-2B - Unified query execution

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| QUERY-001 | CORE | L | CAP-001 | One parser-backed classification and execution contract for editor, AI, MCP, metrics, and admin |
| QUERY-002 | CORE | M | QUERY-001 | Standard cancellation, timeout, paging, warnings, affected rows, and transaction state |

Acceptance:

- All entry points produce the same classification and safety decision for the same SQL.
- Trailing comments, comment-only selections, user LIMIT/OFFSET, and multi-statement fixtures pass per dialect family.
- Prepared parameters are used only where the driver declares support; fallback is explicit and tested.

Exit artifacts: dialect fixture corpus, entry-point contract tests, cancellation report.

#### Sprint groups 2C-2D - SQL editor reliability

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| EDITOR-001 | UI | L | QUERY-001 | Completion hardening for CTE, derived table, alias, join, cross-schema, and large metadata sets |
| EDITOR-002 | UI | M | MIG-001 | Crash-safe unsaved editor and workspace-tab restore |
| EDITOR-003 | UI/CORE | M | QUERY-001, MIG-001 | Full-text query history, saved queries, favorites, and deterministic recent/frequency ranking |

Acceptance:

- Cached completion meets the approved PERF-001 p95 budget.
- Metadata requests are cancellable and cannot repopulate stale schema state.
- Crash restore preserves text, connection identity, database, and cursor position.
- History and saved-query identity remain scoped to the correct connection and database.

Exit artifacts: completion corpus, large-schema benchmark, crash-recovery E2E test.

#### Sprint groups 2E-2F - Credential service

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| CONN-001 | CORE/SEC | L | SEC-001, MIG-001 | OS credential storage and secret migration |
| CONN-002 | CORE | M | OBS-001 | Connection-stage diagnostics, timeout, cancellation, and cleanup |

Acceptance:

- Secrets never appear in exports, logs, crash bundles, screenshots, or copied connection JSON.
- Password sources support prompt, environment, file, and command with explicit trust warnings.
- Diagnostics distinguish DNS, TCP, tunnel, TLS, authentication, and database-selection failures.

Exit artifacts: secret migration tests, redaction suite, failure-injection report.

#### Sprint groups 2G-2H - Enterprise paths

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| CONN-003 | CORE | L | CONN-002 | SOCKS5 with remote DNS and optional authentication |
| CONN-004 | CORE | L | CONN-002 | One managed external tunnel vertical slice: Cloudflare Access or Cloud SQL Auth Proxy |

Deferred follow-ups:

- The second managed tunnel is scheduled as CONN-005 in Phase 3.
- Kerberos/Windows Authentication is CONN-006 and requires a dedicated environment before commitment.

Acceptance:

- Proxy/tunnel readiness, reconnect, cancellation, shutdown, and orphan cleanup are tested.
- Duplicate/export/restore preserves configuration without exposing credentials.
- Unsupported platform combinations are blocked with actionable guidance.

Exit artifacts: integration fixture, lifecycle logs, platform support matrix.

#### Phase 2 gate

- QUERY-001/002, EDITOR-001/002, and CONN-001/002 are `Done`.
- CONN-003 is `Done`; CONN-004 may be release-scoped beta only when labeled and tested.
- Query and connection critical paths pass Windows, macOS, and Linux smoke tests.

### Phase 3 - Administration and AI

#### Sprint groups 3A-3B - Enterprise path closure

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| CONN-005 | CORE | L | CONN-004 | The second managed external tunnel: Cloudflare Access or Cloud SQL Auth Proxy |
| CONN-006 | CORE/SEC | L | CONN-002 | SQL Server Windows Authentication/Kerberos on supported platforms |

Acceptance:

- Cloudflare Access and Cloud SQL Auth Proxy both pass readiness, reconnect, cancellation, shutdown, and orphan-cleanup tests.
- Kerberos fixtures cover existing ticket and explicit-principal flows in a dedicated test environment.
- A missing helper binary, invalid ticket, clock skew, or unsupported platform produces actionable diagnostics.

Exit artifacts: managed-process integration suite, Kerberos environment record, platform support matrix.

#### Sprint groups 3C-3D - Privilege model

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| ADMIN-001 | CORE | L | CAP-001, QUERY-001 | PostgreSQL principal, membership, ownership, grant, inheritance, and effective-access model |
| ADMIN-002 | UI | M | ADMIN-001 | Browsable server/database/schema/table/column privilege workspace |

Acceptance:

- Fixtures cover direct, inherited, public/default, ownership, and grant-option access.
- Unsupported privilege levels are capability-driven, not silently omitted.
- Read-only inspection works without granting write permission to TableR.

Exit artifacts: catalog fixtures, privilege explanation snapshots, security review.

#### Sprint groups 3E-3H - Staged administration and schema/server operations

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| ADMIN-003 | UI/CORE | L | ADMIN-001, GRID-002 | Staged grant/revoke/create/alter operations with undo and SQL preview |
| SCHEMA-001 | CORE | M | QUERY-001, CAP-002 | Cache-safe schema mutation and targeted refresh contract |
| ADMIN-004 | CORE/UI | L | ADMIN-001, ADMIN-003 | MySQL/MariaDB privilege model, fixtures, staging, and effective-access explanation |
| SCHEMA-002 | CORE/UI | L | SCHEMA-001 | Capability-driven DDL workflows for tables, columns, indexes, constraints, views, routines, and triggers |
| SERVER-001 | CORE/UI | L | QUERY-001, CAP-002 | Process/lock inspection, cancellation/termination, activity, slow-query, and maintenance workflows |

Acceptance:

- Reviewed target state matches refreshed catalog state after apply.
- Failed apply reports partial/rolled-back state accurately.
- Schema mutation refreshes affected objects without a full workspace reload.
- PostgreSQL and MySQL-family privilege fixtures pass independently.
- DDL and server-operation actions appear only when the engine contract supports them.
- Long-running server operations expose progress and cancellation where the driver supports it.

Exit artifacts: PostgreSQL integration suite, reviewed SQL fixtures, cache invalidation tests.

#### Sprint groups 3I-3J - Provider streaming

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| AI-001 | AI/CORE | L | OBS-001 | End-to-end provider streaming and cancellation contract |
| AI-002 | AI/UI | M | AI-001 | Separate activity summaries, tool events, assistant text, stopped, failed, and completed states |

Acceptance:

- OpenAI-compatible, Anthropic, and Ollama adapters pass conformance fixtures or are explicitly excluded.
- Stop propagates to HTTP and active database tools.
- Internal chain-of-thought or raw protocol payload is never rendered as user-facing content.
- Partial responses persist with correct terminal state.

Exit artifacts: malformed-stream corpus, cancellation timings, rendering tests.

#### Sprint groups 3K-3M - Grounded agent

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| AI-003 | AI/CORE | L | QUERY-001, CAP-002, AI-001 | Typed schema, sample, aggregate, search, and reviewed-query tools |
| AI-004 | AI/UI | M | AI-003, DATA-001 | Structured source citations and exact table/row/cell navigation |
| AI-005 | AI/SEC | M | SEC-001, AI-003 | Data-egress policy, provider consent, access boundaries, and agent evaluation suite |

Acceptance:

- Agent cannot query an unverified column.
- Data-off mode performs zero live reads.
- Row-level claims link to source when stable identity exists.
- Permission, hallucinated-column, empty-result, ambiguity, write, and cancellation evaluations meet the recorded threshold.
- Provider-bound schema/data is shown in policy and redacted according to settings.

Exit artifacts: evaluation report by provider/model, navigation E2E tests, AI privacy documentation.

#### Phase 3 gate

- PostgreSQL, MySQL, and MariaDB Users & Roles parity passes.
- Cloudflare Access, Cloud SQL Auth Proxy, and supported-platform Kerberos workflows pass their integration matrix.
- Schema and server-operation parity evidence is complete for applicable Tier A engines.
- AI-001 through AI-005 are `Done` before grounded-agent marketing claims.
- No raw trace, secret, unauthorized schema, or unreviewed destructive query appears in AI workflows.

### Phase 4 - Workspace and Integrations

#### Sprint group 4A - Multi-window foundation

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| WORK-001 | UI/CORE | L | MIG-001, EDITOR-002 | Multi-window session ownership and restored window state |
| UI-002 | UI | S | TEST-002 | Extract only workspace styles/components touched by WORK-001 |

Acceptance:

- Closing one window cannot terminate a session still used by another.
- Unsaved editors and active object identity restore correctly.
- Background polling is not duplicated accidentally.

Exit artifacts: multi-window state tests, restart E2E, resource-ownership diagram.

#### Sprint groups 4B-4C - Split panes and navigation

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| WORK-002 | UI | L | WORK-001 | Horizontal/vertical split panes and tab movement |
| NAV-001 | UI | M | WORK-001 | Quick switcher, favorites, recents, and deterministic frecency |

Acceptance:

- Layout, focus, keyboard navigation, tab movement, and close confirmation are deterministic.
- Same-named objects never collide across connection/database/schema.
- Compact and multi-monitor screenshot matrices pass.

Exit artifacts: layout migration tests, keyboard E2E, navigation identity tests.

#### Sprint groups 4D-4E - Encrypted workspace sync

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| SYNC-001 | CORE/SEC | L | MIG-001, SEC-001 | Provider-independent encrypted sync contract, conflict model, and local-only exclusions |
| SYNC-002 | CORE/UI | L | SYNC-001 | One opt-in cross-platform sync provider selected through an architecture decision record |

Acceptance:

- Connections, groups, tags, settings, favorites, and layouts have versioned sync identities.
- Secrets are excluded by default and use a separate explicit policy if ever synchronized.
- Offline edits, concurrent edits, deletion tombstones, corrupt remote records, and key loss have deterministic behavior.
- Sync can be disabled without preventing local use or deleting the local copy.

Exit artifacts: provider ADR, conflict fixtures, encryption review, cross-device E2E report.

#### Sprint groups 4F-4G - Plugin security contract

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| PLUG-001 | SEC/CORE | L | SEC-001, CAP-001 | Versioned plugin manifest, capability permissions, limits, and compatibility checks |
| PLUG-002 | CORE | M | PLUG-001 | Validator CLI and one reference plugin migration |

Acceptance:

- Plugins cannot access secret, filesystem, network, or SQL capabilities without declared permission.
- Invalid/incompatible plugins fail before activation.
- Plugin failure cannot crash the workspace.

Exit artifacts: malicious-plugin fixtures, validator output, migration guide.

#### Sprint groups 4H-4I - MCP hardening

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| MCP-001 | CORE/SEC | L | QUERY-001, CAP-002, SEC-001 | Protocol negotiation, pairing, token scopes, rotation/revocation, and per-connection policy |
| MCP-002 | CORE | M | MCP-001, OBS-001 | Concurrent calls, progress, cancellation, rate limits, idle recovery, and audit history |

Acceptance:

- Protocol conformance and abuse/security fixtures run in CI.
- Revocation cancels active requests and blocks future calls.
- MCP cannot bypass safe mode, capability, AI policy, or connection policy.

Exit artifacts: conformance report, security test report, setup documentation.

#### Phase 4 gate

- WORK-001/002, NAV-001, SYNC-001/002, PLUG-001/002, and MCP-001/002 are `Done`.
- Multi-window, split-pane, plugin, and MCP critical paths pass release E2E.
- No known session-leak, token-bypass, or workspace-restore P0/P1 defect remains.

### Phase 5 - Parity Stabilization and v0.1.5 Release

#### Sprint groups 5A-5B - Cross-platform quality

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| QUAL-001 | UI/REL | L | All prior releases | Full keyboard, focus, screen-reader, reduced-motion, overflow, DPI, and compact-window audit |
| QUAL-002 | REL | M | PERF-001 | Startup, memory, grid, import, editor, ERD, and AI benchmark suite |

Acceptance:

- Critical workflows are keyboard-usable.
- No P0/P1 clipping, overlap, unreachable action, or broken focus path remains in the viewport matrix.
- Regressions exceeding the approved variance require an explicit release waiver and cannot affect data safety.

Exit artifacts: accessibility checklist, screenshot matrix, benchmark comparison.

#### Sprint groups 5C-5D - Tier A closure

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| TIERA-001 | CORE/REL | L | All Tier A work | PostgreSQL/MySQL/MariaDB/SQLite capability and integration closure |
| MIG-002 | CORE/REL | M | MIG-001 | Upgrade, failed-upgrade, backup, recovery, and downgrade-support release drill |

Acceptance:

- Every applicable Tier A capability is tested or explicitly removed from the release claim.
- A clean v0.1.4b profile upgrades without losing connections, settings, queries, or workspace state.
- Recovery from an injected migration failure is documented and tested.

Exit artifacts: generated capability matrix, migration drill, unresolved Tier B/C limitation list.

#### Sprint groups 5E-5F - Release trust and parity review

| ID | Owner | Size | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| REL-001 | REL/SEC | L | QUAL-001, TIERA-001 | Installer, updater, checksum, latest-release, website download, and clean-machine release tests |
| PARITY-001 | REL | M | All parity work | Evidence-based TableR/TablePro workflow comparison and go/no-go review |
| PROD-002 | REL | M | PROD-001, QUAL-001 | Moderated parity-candidate usability pilot with representative users and the baseline task set |

Acceptance:

- Windows, macOS, and Linux artifacts install, launch, connect, update, and uninstall on clean test machines.
- Unsigned macOS limitations are explicit; signed/notarized distribution remains `Blocked` until credentials exist and is not falsely claimed.
- GitHub release state, updater metadata, checksums, and website downloads agree automatically.
- Section 12 has no failed required gate.
- Pilot participants complete the critical task set without a P0/P1 usability blocker; findings and exceptions are recorded.

Exit artifacts: clean-machine report, release manifest, parity evidence pack, usability report, signed go/no-go decision.

## 9. Continuous Workstreams

These are not dumping grounds. Each item still requires an ID and sprint capacity.

### Security

- Update threat model when adding a provider, protocol, credential source, tunnel, or plugin permission.
- Run secret scanning, dependency audit, Rust advisory audit, frontend audit, and SBOM generation in release CI.
- Review CSP, updater trust, deep-link validation, command allowlists, local server exposure, and log redaction.
- Track accepted risks with owner and expiry date.

### Migration and compatibility

- Version every persisted schema.
- Back up before destructive migration.
- Test the complete v0.1.4b to v0.1.5 upgrade path, including backup, interrupted migration, recovery, and documented downgrade limits.
- Document downgrade support explicitly; never imply rollback when state is not backward compatible.

### Observability

- Use operation IDs across UI, Tauri command, driver, AI tool, and MCP request.
- Record duration, cancellation, result size, and classified failure without sensitive values.
- Keep telemetry opt-in. Local diagnostic logging must work without telemetry.
- Define crash-free session, connection success, query success, and cancellation success metrics before product claims.

### Product validation

- Maintain one primary persona and a ranked set of professional workflows; secondary personas cannot silently expand committed scope.
- Re-run the baseline task comparison at every phase gate using the same fixtures where possible.
- Record task completion, error recovery, time on task, and critical usability failures.
- Product telemetry remains opt-in; moderated tests and local benchmark scripts must work without telemetry.
- A feature that has no named user problem, expected outcome, and validation method stays outside the committed release.

### Architecture

- No big-bang rewrite of DataGrid, ERD, AI workspace, or the shared stylesheet.
- Extract modules only as part of a tested vertical feature slice.
- New production modules above 600 lines require a review note; above 1,000 lines require an approved exception.
- Feature state machines and backend contracts remain independent of presentation components.

## 10. Test Strategy

### Pull-request lane

Target duration: 15 minutes.

- Typecheck, lint, frontend unit/component tests, and production build.
- Rust format, Clippy policy, focused unit tests, and changed-driver contract tests.
- PostgreSQL/SQLite critical smoke tests for affected workflows.
- Migration and security tests when relevant paths change.

No blind retries. A flaky test is quarantined only with an owner, issue, and seven-day expiry.

### Nightly lane

- Full frontend and Rust suites.
- Tier A integration matrix.
- Selected Tier B/C connection/query/export smoke tests.
- Large-schema editor benchmark, grid-scroll benchmark, and 1 GB import/export fixture.
- Dependency, advisory, secret, and SBOM checks.

### Release-candidate lane

- Critical desktop E2E on Windows, macOS, and Linux.
- Installer/updater/clean-profile/N-1 migration tests.
- Screenshot matrix for launcher, workspace, grid, editor, chart, ERD, AI, settings, and modal layering.
- Manual exploratory checklist with tester, build SHA, OS, result, and evidence.

## 11. Performance Measurement

PERF-001 must define reference machines before thresholds become release gates.

Measurement protocol:

- Use fixed app build, database fixture, row count, schema size, network profile, and power mode.
- Run at least 10 repetitions; report median and p95.
- Separate cold process launch from warm window creation.
- Measure process-tree memory after a five-minute idle stabilization period.
- Record baseline, candidate, absolute delta, and percentage delta.

Provisional targets to validate during v0.1.5:

| Workflow | Candidate target |
| --- | --- |
| Warm app launch | Median <= 2.5 seconds |
| Idle process-tree memory | Median <= 180 MB on reference workspace |
| First grid paint after rows arrive | p95 <= 150 ms |
| Grid interaction | p95 frame time <= 20 ms on reference dataset |
| Cached SQL completion | p95 <= 100 ms |
| Query-cancel UI acknowledgement | p95 <= 200 ms |
| AI transport overhead to first token | p95 <= 300 ms beyond measured provider/network time |
| AI stop UI acknowledgement | p95 <= 200 ms |
| Streaming import/export | Peak memory bounded by configured buffers, not file size |

Targets become binding only after PERF-001 records hardware, scripts, baseline variance, and approved thresholds.

## 12. Parity Gate

Each row requires an evidence link and `Pass`. `Partial` is a no-go for publishing v0.1.5.

| Area | Required evidence | Required by | Status |
| --- | --- | --- | --- |
| Driver capabilities | Generated 19-engine matrix and Tier A contract suite | Phase 0 and final gate | Planned |
| Grid selection/editing | Range, clipboard, undo/redo, safe mutation E2E | Phase 1 | Planned |
| Column layouts | Persisted scoped layout and migration tests | Phase 1 | Planned |
| Import/export | 1 GB benchmark, rollback, cancellation, type round-trip | Phase 1 | Planned |
| Query execution | Shared entry-point and dialect contract tests | Phase 2 | Planned |
| SQL editor | Completion benchmark and crash restore | Phase 2 | Planned |
| Credentials/connections | Redaction, cancellation, diagnostics, proxy/tunnel tests | Phase 2 | Planned |
| Enterprise paths | SOCKS5, Cloudflare Access, Cloud SQL Auth Proxy, and supported-platform Kerberos integration tests | Phase 3 | Planned |
| Users & Roles | PostgreSQL and MySQL-family privilege fixtures, staging, undo, preview | Phase 3 | Planned |
| Schema/server operations | Capability-driven DDL, targeted refresh, long-operation handling | Phase 3 | Planned |
| AI | Streaming, grounded tools, privacy policy, evaluation, row navigation | Phase 3 | Planned |
| Multi-window/splits | Restore, focus, resource ownership, multi-monitor E2E | Phase 4 | Planned |
| Navigation | Qualified identity, favorites, recents, quick switcher | Phase 4 | Planned |
| Workspace sync | Encryption, conflicts, exclusions, offline behavior, and cross-device E2E | Phase 4 | Planned |
| Plugin/MCP | Permission, protocol, revocation, abuse, and conformance tests | Phase 4 | Planned |
| Security | Threat model, audits, SBOM, secret tests, accepted-risk review | Every phase and final gate | Planned |
| Migration/recovery | v0.1.4b to v0.1.5 upgrade and injected-failure drill | Phase 5 | Planned |
| Accessibility/UI | Keyboard and viewport evidence matrix | Phase 5 | Planned |
| Performance | Reproducible baseline and regression report | Phase 5 | Planned |
| Release trust | Clean-machine install/update/uninstall and artifact consistency | Phase 5 | Planned |
| Product validation | Baseline task comparison and representative-user parity pilot | Phase 0 and final gate | Planned |

Known external exception:

- Apple signing/notarization is blocked by credentials and budget. TableR may still release an explicitly unsigned macOS artifact, but cannot claim trusted macOS distribution parity until this exception is closed.

## 13. Definition of Done

A work item is `Done` only when:

- Acceptance behavior covers success, empty, loading, error, cancel, retry, and permission states where applicable.
- Backend capability and safety checks exist; hiding a UI action is insufficient.
- Unit and integration tests cover domain logic.
- Critical user paths have desktop E2E evidence.
- Persisted-state changes include migration and recovery tests.
- Sensitive paths pass security and redaction review.
- Data-intensive paths include benchmark evidence.
- Windows, macOS, and Linux behavior is tested or explicitly scoped.
- User documentation and release notes are updated.
- Tracking issue and implementation commit/PR are linked.

Implemented code without evidence remains `Verification`, never `Done`.

## 14. Risk Register

| Risk | Probability | Impact | Mitigation | Review point |
| --- | --- | --- | --- | --- |
| One-engineer capacity causes schedule slip | High | High | Enforce WIP limit, split XL work, reforecast each release | Every sprint |
| Driver differences expand Tier A scope | High | High | Capability contract and vertical slices before broad rollout | v0.1.5 exit |
| Desktop E2E tooling is unstable across OSes | Medium | High | TEST-001 time-boxed spike and fallback smoke strategy | Sprint group 0C |
| Grid refactor creates data-loss regressions | Medium | Critical | State-machine tests, vertical extraction, Tier A integration tests | Every grid sprint |
| Persisted-state migration corrupts profiles | Medium | Critical | Backup, fixtures, failure injection, N-1 drills | Every migration |
| AI sends unauthorized data | Medium | Critical | Explicit egress policy, consent, tool scopes, redaction tests | Sprint groups 3K-3M |
| Plugin/MCP expands attack surface | High | High | Threat model, scopes, rate limits, malicious fixtures | Phase 4 |
| Unsigned macOS build harms adoption | High | Medium | Clear installation docs; track signing as external blocker | Final release gate |
| Competitive target changes during program | Medium | Medium | Re-audit TablePro at each phase gate, without silently expanding scope | Every phase gate |

## 15. Current Board

This board tracks only committed execution work. Existing partial features stay in the baseline until their roadmap item becomes active.

| ID | Status | Target sprint group | Evidence |
| --- | --- | --- | --- |
| ROAD-001 | Verification | 0A | [Sprint evidence](roadmap/SPRINT_0A_EVIDENCE.md), [issue #65](https://github.com/minhe51805/TabLer/issues/65), [draft PR #66](https://github.com/minhe51805/TabLer/pull/66), [template](roadmap/EVIDENCE_TEMPLATE.md), and commit `79874a2`; review pending |
| CAP-001 | Verification | 0A | [Sprint evidence](roadmap/SPRINT_0A_EVIDENCE.md), [Rust catalog](../src-tauri/src/database/capabilities.rs), and [generated matrix](generated/driver-capabilities.json) |
| SEC-001 | Verification | 0A | [Threat model](security/THREAT_MODEL.md) records assets, boundaries, 15 threats, controls, owners, and accepted risks; review pending |
| PROD-001 | Verification | 0A | [Workflow baseline](product/PROFESSIONAL_WORKFLOW_BASELINE.md) defines persona, fixtures, 10 workflows, metrics, and remaining moderated validation |
| CAP-002 | Verification | 0B | [Sprint evidence](roadmap/SPRINT_0B_EVIDENCE.md); backend command guards, capability-driven UI, and canonical object identity implemented; review pending |
| MIG-001 | Verification | 0B | [Sprint evidence](roadmap/SPRINT_0B_EVIDENCE.md) and [recovery guide](operations/STORAGE_RECOVERY.md); four migration fixtures pass; review pending |
| TEST-001 | Planned | 0C | Not started |
| TEST-002 | Planned | 0C | Not started |
| OBS-001 | Planned | 0C | Not started |

The board is updated when work enters a sprint. Future-release items remain in Section 8 until their release planning review.

## 16. Immediate Next Actions

1. Complete review and CI verification for Sprint groups 0A and 0B.
2. Run the Tier A manual capability check for edit, import, schema, export, restore, and administration controls.
3. Start TEST-001 as a time-boxed desktop E2E framework spike.
4. Use the selected E2E path to implement TEST-002 launch/connect/query/browse smoke coverage.
5. Implement OBS-001 structured redacted logs and diagnostic bundle export before closing Phase 0.

No new database engine or unrelated major UI feature should enter the train before the Phase 0 gate.
