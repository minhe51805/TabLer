# Desktop E2E Test Strategy

Status: Accepted for Sprint 0C

Decision date: 2026-07-18

Scope: launch, connect, query, and browse smoke coverage

## Decision

TableR uses WebdriverIO with `@wdio/tauri-service`, the external `tauri-driver` provider, and a debug-only IPC bridge. The first local proof runs on Windows. CI runs the same application-level smoke scenario on Linux against SQLite and PostgreSQL fixtures.

The external provider drives the compiled Tauri application. Reliable command-level assertions use `tauri-plugin-wdio`, compiled only by Cargo feature `e2e` and enabled only by `tauri.e2e.conf.json`; the production build has neither the dependency nor its capability. The runner owns fixture creation, application data isolation, driver startup, screenshots, and failure metadata.

## Rejected Options

| Option | Reason rejected for this baseline |
| --- | --- |
| Browser-only Playwright | Tests React behavior but does not prove Tauri commands, desktop startup, or native integration. It remains useful for focused UI tests. |
| Embedded WebDriver provider as the application driver | Supports more platforms but replaces the selected external lifecycle and requires a broader embedded test surface. Revisit only for macOS coverage after a security review. |
| Direct Selenium/WebDriver wiring | Duplicates application lifecycle, driver installation, and log capture already handled by the Tauri WebdriverIO service. |
| Manual-only desktop regression | Cannot serve as a repeatable release gate and leaves failures without durable evidence. |

## Platform Limits

- External `tauri-driver` supports Windows and Linux; it does not provide macOS desktop automation.
- Linux requires WebKitGTK WebDriver and a display server. CI uses `webkit2gtk-driver` under Xvfb.
- macOS remains a manual smoke lane until an embedded-provider spike is approved.
- The initial suite is intentionally small. It proves critical wiring and is not a replacement for frontend unit and integration tests.

## Test Contract

Each engine scenario must:

1. Start with an isolated `TABLER_DATA_DIR`.
2. Create deterministic fixtures before launching TableR.
3. Verify the compiled desktop app can connect to the saved fixture through its real Tauri command boundary.
4. Browse `smoke_items` through the production table command and verify known rows.
5. Execute a count query through the production query command and verify the result.
6. Save a screenshot for successful and failed runs.
7. Retain frontend/backend logs and failure metadata in `.artifacts/e2e`.
8. Remove the isolated runtime, saved fixture connections, and fixture database before evidence upload.

This command-level smoke proves desktop startup, IPC registration, storage bootstrap, driver connection, schema discovery, table reads, and query execution. Detailed launcher clicks, editor gestures, and grid interactions remain separate UI E2E scenarios; this baseline does not claim to cover them.

The official driver may leave child driver processes alive on Windows after its launcher hook returns. The runner snapshots only managed E2E process names before launch and stops only PIDs created by that run. It records the result in `cleanup.log`; pre-existing TableR or driver processes are never targeted.

CI uploads the artifact directory even when a test or setup step fails.

## Commands

```text
npm run build:e2e
npm run test:e2e
```

Set `TABLER_E2E_ENGINE=postgresql` and the `TABLER_E2E_POSTGRES_*` variables for the PostgreSQL scenario.
