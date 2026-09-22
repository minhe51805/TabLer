# AGENTS.md — TableR project memory

Canonical, versioned context for **any** coding agent working in this repo (Cline,
Claude Code, Qwen, Copilot, …). Read this before touching code. `CLAUDE.md` is a local
pointer to this file and is intentionally gitignored.

## 1. What this is

TableR is a desktop database workspace: a Tauri 2 shell (Rust backend) + React 19 /
TypeScript frontend, with pluggable database drivers and an in-app autonomous SQL
agent. Built-in engines: SQLite, PostgreSQL, MySQL, SQL Server, DuckDB, Cassandra,
Redis, libSQL (the last four are feature-gated).

| Layer           | Tech                                |
| --------------- | ----------------------------------- |
| Desktop runtime | Tauri 2                             |
| Frontend        | React 19, TypeScript 5, Vite        |
| Native backend  | Rust, Tokio                         |
| DB access       | SQLx + engine-specific Rust drivers |
| Unit tests      | Vitest (`tests/**`)                 |
| E2E             | Playwright via `e2e/run.mjs`        |

## 2. Commands that actually exist

Run these verbatim; do not invent script names.

### Frontend

```bash
npm run typecheck           # tsc --noEmit
npm run lint                # eslint src tests --max-warnings=0
npm run test:run            # vitest run (all unit tests)
npm run test                # vitest watch
npm run check:frontend      # typecheck && lint && test:run && build  <- the gate
npm run eval:agent          # vitest run tests/eval   (agent golden set)
npm run build:e2e && npm run test:e2e
```

### Rust backend

```bash
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml -- --include-ignored
cargo check --manifest-path src-tauri/Cargo.toml
```

### Repo contracts (all must pass before a release)

```bash
npm run check:release-contract                  # needs RELEASE_TAG env
RELEASE_TAG=v0.1.6a npm run check:release-contract
npm run check:tauri-target
npm run check:sql-splitter
npm run check:secrets
npm run build:plugin-registry
```

### Formatting

`husky` + `lint-staged` run on commit: ESLint `--fix` + Prettier for
`ts/tsx/js/json/css/md/yml/html`, and `rustfmt --edition 2021` for `*.rs`.
Manual: `npm run format` / `npm run format:check` / `npm run lint:fix`.

## 3. CI (`.github/workflows/`)

| Workflow                         | Gate                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ci.yml` → Frontend quality      | `npm ci --legacy-peer-deps`, `npm run check:frontend`, `npm run eval:agent`                                         |
| `ci.yml` → Rust quality          | `cargo fmt --check` + `clippy -D warnings`, `cargo test -- --include-ignored`, reference-sidecar e2e, `cargo check` |
| `ci.yml` → SQLite/Postgres smoke | integration paths                                                                                                   |
| `release-validation.yml`         | clean-machine build on linux/macos/windows                                                                          |
| `release.yml`                    | `Verify release source` + 3 platform builds → GitHub Release                                                        |
| `e2e.yml`                        | Playwright suite                                                                                                    |
| `plugins.yml`                    | plugin registry/repository artifacts                                                                                |

An agent that edits code **must** run the matching local command(s) before claiming
done. Never report success without a command's output.

## 4. Layout

```
src/                        React frontend
  components/AISlidePanel/  the in-app SQL agent: ONE FILE PER CONCERN
  components/DataGrid/      grid, selection, editing
  stores/                   zustand stores (skillPrefsStore, skillUsageStore, …)
  utils/                    cross-cutting helpers (ai-*.ts)
src-tauri/src/              Rust backend
  ai_skills.rs              Agent Skills discovery (SKILL.md) + caps
  agent_memory.rs           per-connection/database memory (MEMORY.md)
  commands/                 tauri command modules (schedule.rs, …)
  sidecar_bins/             feature-gated sidecar binaries — SEE §5
scripts/                    node contract checks (check-*.mjs) and builders
tests/                      vitest unit tests; tests/eval = agent golden set
e2e/                        Playwright specs + runner
docs/architecture/          normative docs (tracked)
plans/                      per-work-item plans (LOCAL ONLY — gitignored)
.claude/                    agent assets; see §8
plugins/                    database driver plugins
```

## 5. Hard-won facts — do NOT rediscover these the painful way

1. **Sidecars live in `src-tauri/src/sidecar_bins/`, not `src-tauri/src/bin/`.**
   Tauri CLI 2.10 (pinned in `package-lock.json`) bundles **every** file in
   `src/bin/` as a sidecar and ignores `required-features`, so the bundler tries to
   copy sidecars that were never built → `Failed to copy binary … does not exist`
   (linux/macos) and a `light.exe` WiX failure on Windows. Do not move them back
   until `@tauri-apps/cli` is bumped (upstream fix in 2.11.4+). The five `[[bin]]`
   entries in `src-tauri/Cargo.toml` carry a comment explaining this.
2. **Release label ≠ Cargo version.** `package.json` → `"releaseLabel"` is the
   user-facing tag (e.g. `0.1.6a`); Cargo/SemVer cannot express `0.1.6a`, so the
   bundle stays `0.1.6`. `scripts/check-release-contract.mjs` is the binding
   contract between the two. Editing one without the other breaks the release job.
3. **`bundle.resources` is unset** in `src-tauri/tauri.conf.json`. There is no
   bundled resource directory at runtime — do not assume one. Ship static assets via
   `include_str!`/`include_bytes!` or an explicit `resources` entry (which must then
   work across NSIS, MSI/WiX, `.dmg`, AppImage, `.deb` and `.rpm`).
4. **Updater manifest**: the release job only emits `latest.json` when
   `TAURI_SIGNING_PRIVATE_KEY` is configured. Without it,
   `releases/latest/download/latest.json` 404s. Pre-existing, not a regression.
5. **`.claude` and `plans/` are gitignored** (`plans` entirely; `.claude` with an
   `!` allow-list for the versioned agent assets). `docs/*` is gitignored with an
   explicit `!` allow-list per file/directory — follow that idiom when a new doc
   must be tracked.
6. **`vX.Y.Za` tags are re-cut lightweight tags.** A release tag may be force-moved
   to the fix commit (`v0.1.6a` was). Check `git rev-parse <tag>` against the commit
   you expect before reasoning about a release.
7. **Test placement**: frontend tests live in `tests/` mirroring `src/` paths
   (agent modules → `tests/utils/ai-agent-*.test.ts`); Rust tests are inline
   `#[cfg(test)] mod tests`.

## 6. Conventions

- **Language**: all code comments, docs, commits and plan files in **English**.
- **Naming**: `kebab-case.ts` modules, `PascalCase.tsx` components, `snake_case.rs`,
  Tauri commands exposed as `camelCase` via `#[tauri::command]`.
- **UI strings**: new user-facing copy goes in a per-feature `*-copy.ts` module
  next to the component (e.g. `connection-error-copy.ts`, `window-menu-copy.ts`),
  **not** in `src/i18n/*.ts`. The i18n files are a merge-conflict hotspot for
  parallel edits; copy modules expose a `get<Feature>Copy(language)` accessor
  with per-language objects and an English fallback.
- **CSS**: do NOT add rules to `src/styles/app-components.css` (40k lines,
  duplicate selectors have already caused contrast bugs). New feature styles
  go in a per-feature stylesheet next to the component (e.g.
  `ai-insights.css`, `datagrid-power-copy.css`) imported by the component.
  Existing rules stay; only move them when touching that area anyway.
- **AISlidePanel discipline**: one file per concern (context assembly, tool schema,
  tool executor, verification, cost, memory recall, …). When adding agent behaviour,
  extend the matching module instead of growing an unrelated one.
- **Tool surface**: every agent tool is declared in
  `src/components/AISlidePanel/tool-schema/specs.ts`; the executor switch lives in
  `ai-agent-tool-executor.ts`. A tool is not "added" until both know about it.
- **Docs**: normative design docs go to `docs/architecture/*.md` (tracked).
- **Plans**: `plans/<YYMMDD-HHMM>-<slug>/PLAN.md` (local only) — gap analysis, code
  path tables, acceptance criteria.
- **Commits**: Conventional Commits (`fix(scope): …`, `feat(scope): …`,
  `refactor(scope): …`, `docs: …`, `test: …`, `chore: …`).
- **Never** delete or rewrite a released tag; never `git push --force` to
  `main`/`develop`.

## 7. SQL-path review rules (what reviewers must flag)

Always a bug:

- SQL assembled by string interpolation of user/model input instead of bind
  parameters; identifiers not allow-listed.
- `run_readonly_sql` / `preview_write` bypassed to execute a statement directly.
- A write path that can succeed without an explicit confirmation (safe-mode or
  rule-engine gate skipped, or its verdict discarded).
- Errors swallowed on the SQL path: `catch {}`, `let _ =`, `unwrap_or_default()`,
  `.ok()` without logging, or an engine silently substituted as a fallback.
- A row count / affected-row count that is claimed but never read back.

Never acceptable:

- Moving a sidecar back into `src-tauri/src/bin/` before the Tauri CLI bump (§5.1).
- Changing `releaseLabel` or the Cargo version without running the contract check.
- Adding a desktop-app dependency for an agent skill's convenience.

## 8. Agent assets

See `docs/architecture/AGENT_SKILLS.md` for the normative contract.

- Shared, versioned: `.claude/skills/`, `.claude/agents/`, `.claude/commands/`,
  `.claude/rules/`, `.claude/hooks/`.
- Personal, gitignored: `.claude/agent-memory/`, `.claude/settings.local.json`,
  anything else under `.claude/`.
- The **in-app** agent skills/rules/memory are a different system entirely: they live
  under the app data dir (`<data_dir>/skills`, `<data_dir>/rules`) plus per-connection
  memory. Do not confuse the two.
