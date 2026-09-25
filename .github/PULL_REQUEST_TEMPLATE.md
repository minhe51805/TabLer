## What

<!-- One paragraph: what this PR does and why. Link the issue it closes. -->

Closes #

## How

<!-- The approach — what changed, what was considered and rejected. -->

## Verification

<!-- What you ran and observed. For UI changes, a screenshot or recording. -->

- [ ] `npm run check:frontend` passes (typecheck + lint + tests + build)
- [ ] Rust changes: `cargo fmt --check` + `cargo clippy -- -D warnings` + `cargo test`
- [ ] Touched the SQL path → reviewed against `AGENTS.md` §7 rules
- [ ] New agent tool → declared in `tool-schema/specs.ts` AND wired in `ai-agent-tool-executor.ts`
- [ ] New user-facing copy → in a `*-copy.ts` module, not `src/i18n`
- [ ] Version/release label untouched — or `RELEASE_TAG=v… npm run check:release-contract` run

## Screenshots / recordings

<!-- Required for UI changes. -->
