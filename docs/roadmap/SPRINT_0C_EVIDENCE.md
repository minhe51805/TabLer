# Sprint 0C Evidence

Sprint group: 0C - E2E and observability foundation

Status: Verification

Branch: `feature/sprint-0c-e2e-observability`
Tracking issue: [#69](https://github.com/minhe51805/TabLer/issues/69)

Draft pull request: [#70](https://github.com/minhe51805/TabLer/pull/70)

Implementation commit: `db3da2e`

## TEST-001 Desktop E2E Spike

- Decision record: `docs/architecture/E2E_TEST_STRATEGY.md`.
- Selected: WebdriverIO plus external Tauri driver and a Cargo-feature-gated IPC bridge.
- First platform: Windows local proof.
- CI platform: Linux with WebKitGTK WebDriver and Xvfb.
- Known gap: external macOS automation is unavailable and remains a manual lane.
- Production exclusion: the bridge dependency, plugin registration, frontend import, and capability exist only in E2E builds.

## TEST-002 Smoke Suite

- Runner: `e2e/run.mjs`.
- Scenario: `e2e/specs/workspace-smoke.e2e.mjs`.
- Fixtures: `src-tauri/examples/prepare_e2e_fixtures.rs`.
- Engines: SQLite and PostgreSQL.
- Coverage: compiled desktop launch, saved-fixture connection, schema discovery, table read, and query execution through production Tauri commands.
- Failure evidence: screenshot, frontend/backend logs, and JSON failure metadata.
- Artifact privacy: the runner copies the redacted app log, then removes runtime connections and fixture databases before upload.
- Lifecycle evidence: `cleanup.log` records run-owned process cleanup; the final Windows proof left no new driver or TableR process.
- CI: `.github/workflows/e2e.yml`, artifacts retained for 14 days.

## OBS-001 Observability

- JSONL logs at `<TableR data directory>/logs/tabler.jsonl` with 5 MB startup rotation.
- Mandatory redaction covers credentials in URLs, password/token/API-key fields, bearer tokens, and SQL string literals.
- Query logs contain statement and parameter counts instead of raw SQL or parameter values.
- Query execution and diagnostic export events carry operation IDs.
- Diagnostic export includes app/platform metadata and sanitized logs only.
- Saved connections, credentials, AI data, query results, and database rows are excluded.
- Export requires an explicit UI review backed by a one-use, ten-minute review token.

## Verification Commands

```text
npm run typecheck
npm run lint
npm run test:run
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml
npm run build:e2e
npm run test:e2e
npm audit
```

## Local Verification Results

| Check | Result |
| --- | --- |
| TypeScript | Pass |
| ESLint | Pass with 61 pre-existing warnings and 0 errors |
| Frontend tests | Pass: 293 tests |
| Production frontend build | Pass; bundle scan excludes the E2E bridge |
| Rust tests | Pass: 114 tests, 2 service-dependent tests ignored |
| Rust production check | Pass; dependency tree excludes `tauri-plugin-wdio` |
| SQLite desktop smoke | Pass on Windows: launch, connect, discover, browse, and query |
| Artifact privacy | Pass: runtime connections/database removed; redacted app log retained |
| Dependency audit | Pass: 0 vulnerabilities across production and development dependencies |
| PostgreSQL desktop smoke | Pending Linux CI service evidence; Docker was unavailable locally |

The sprint remains `Verification` until the Linux SQLite/PostgreSQL workflow passes and its immutable artifact link is recorded here.
