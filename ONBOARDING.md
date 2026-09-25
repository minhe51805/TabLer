# Onboarding — your first week on TableR

Read this top to bottom the first day; skim back when you hit each stage.

> **Prerequisite:** skim [AGENTS.md](AGENTS.md) §1 (what this is), §2
> (commands that actually exist), §5 (hard-won facts) and §7 (SQL-path review
> rules). That file is the ground truth — this doc is the _sequence_ to learn
> it in.

## Day 0 — get it running

```bash
git clone https://github.com/minhe51805/TabLer.git && cd TabLer
npm ci --legacy-peer-deps   # --legacy-peer-deps is REQUIRED, not a hint
npm run tauri -- dev        # first build compiles Rust; give it time
```

Prereqs beyond Node 20+: Rust stable, and the Tauri 2 system deps
(`libwebkit2gtk-4.1-dev` etc. on Linux — see
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)).

If the app opens and you can add a SQLite connection → you are set up. Stop here.

## Day 1 — learn the shape

Read in this order; each one is short and answers a specific question:

| Order | Doc                                                                             | Answers                                                                                                |
| ----- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1     | [QUERY_LIFECYCLE](docs/architecture/QUERY_LIFECYCLE.md)                         | What happens between typing SQL and seeing rows — every command, timeout and safety check on the path. |
| 2     | [SAFE_MODE_VS_CODEX_APPROVAL](docs/architecture/SAFE_MODE_VS_CODEX_APPROVAL.md) | Why a write can be blocked or ask twice.                                                               |
| 3     | [AGENT_SKILLS](docs/architecture/AGENT_SKILLS.md)                               | The AI panel's skill/rule/memory system + the P8–P10 agent features.                                   |
| 4     | [PLUGIN_DRIVER_DISTRIBUTION](docs/architecture/PLUGIN_DRIVER_DISTRIBUTION.md)   | How engines beyond the built-ins ship as plugins.                                                      |
| 5     | [E2E_TEST_STRATEGY](docs/architecture/E2E_TEST_STRATEGY.md)                     | How the Playwright e2e runner works and when to write one.                                             |
| 6     | [TECH_DEBT_AUDIT](docs/architecture/TECH_DEBT_AUDIT.md)                         | Known debt; check before "fixing" something that is deliberate.                                        |
| 7     | [driver-integration](docs/driver-integration.md)                                | The real-server driver harness + the engine roadmap.                                                   |

Then open the code in the same order: `src-tauri/src/lib.rs` (command
registration) → `commands/table.rs` (a representative command file) →
`database/driver.rs` (the engine trait) → `database/sqlite.rs` (a concrete
impl). The frontend entry is `src/App.tsx` → `components/layout/WorkspaceShell`.

## Day 2 — your first change, safely

Pick a bug tagged `good first issue`, or a one-file fix you can scope. Before
you edit:

- **Find the convention first.** `src/components/` is one-file-per-concern;
  `src/stores/` is zustand; new user-facing strings go in a `*-copy.ts` next to
  the component (en/vi/ko/tr/zh objects + `get<Feature>Copy(language)`
  accessor), **never** `src/i18n/`.
- **New agent tool?** Declare in `AISlidePanel/tool-schema/specs.ts` _and_ wire
  in `ai-agent-tool-executor.ts` — one without the other is a half-added tool.
- **SQL-path edits** get reviewed against AGENTS.md §7 — bind params, never
  interpolate; `run_readonly_sql`/`preview_write` may not be bypassed; a write
  must never succeed without its gate.

## Before you open the PR

```bash
npm run check:frontend        # typecheck + lint + tests + build — the gate
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run check:test-discipline  # LOC ratio must not drop below baseline
```

Rules that will fail your PR and are easy to miss:

- `npm ci --legacy-peer-deps` — plain `npm install` will fight the lockfile.
- **Never** move files into `src-tauri/src/bin/` — the Tauri 2.10 bundler
  copies everything there; sidecars live in `src-tauri/src/sidecar_bins/`
  until the CLI is bumped (AGENTS.md §5.1).
- `releaseLabel` in `package.json` ≠ Cargo version — they are deliberately
  out of sync and `check:release-contract` enforces the mapping.
- Editing `app-components.css` is a last resort (40k lines, duplicate
  selectors have already caused bugs); new feature styles go in a colocated
  `*.css` next to the component.
- Tests mirror `src/` under `tests/` (`tests/components/`, `tests/utils/`,
  `tests/stores/`); Rust tests are inline `#[cfg(test)] mod tests`.
- Conventional Commits (`fix(scope):`, `feat(scope):` …) — the changelog is
  generated from them.

## The traps that cost people a day (AGENTS.md §5, plain)

1. Sidecars must not move to `src/bin/` before the Tauri CLI 2.11.4+ bump.
2. `v0.1.6a`-style release tags are lightweight and can be force-moved — check
   `git rev-parse <tag>` before reasoning about a release.
3. `bundle.resources` is unset — no bundled resource dir exists at runtime.
4. The updater only emits `latest.json` when `TAURI_SIGNING_PRIVATE_KEY` is
   configured on the release job; a 404 there is expected, not a regression.
5. `plans/` and `.claude/` are gitignored — plans are local work products;
   only `docs/` (allow-listed) and code ship.

## Where to ask

- Stuck on setup: GitHub Discussions.
- Think you found a bug: search Issues first; the report template is in
  CONTRIBUTING.md.
- About to touch the SQL path or the agent executor: read the matching
  architecture doc first, then the AGENTS.md section for it.
