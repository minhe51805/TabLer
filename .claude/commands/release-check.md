---
description: Pre-release verification — format, lint, types, tests, contracts, agent assets
argument-hint: Optional release tag (defaults to the package releaseLabel)
allowed-tools: Bash(npm run:*), Bash(cargo fmt:*), Bash(cargo test:*), Bash(cargo check:*), Bash(node:*), Bash(git describe:*), Bash(git status:*)
---

## Context

- Branch: !`git branch --show-current`
- Status: !`git status --short`
- Release label: !`node -p "require('./package.json').releaseLabel"`
- Latest tag: !`git describe --tags --abbrev=0`
- Cargo version: !`node -p "/(?<=^version = \").*(?=\")/m.exec(require('fs').readFileSync('src-tauri/Cargo.toml','utf8'))[0]"`

## Your task

Run the release gates **in this order** and stop at the first failure. Report each
gate as PASS/FAIL with the exact command and, on failure, the first actionable error
line — never summarise a failure as "some tests failed".

1. `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
2. `npm run check:tauri-target`
3. `npm run format:check`
4. `npm run typecheck` and `npm run lint`
5. `npm run check:agent-skills` — the built-in skill pack obeys the 200-char description
   cap, the 8 000-char body cap and the tool allowlist
6. `npm run check:release-contract` — the release label in `package.json` must match the
   Cargo version. If the user supplied a tag, pass it:
   `RELEASE_TAG=<tag> npm run check:release-contract`
7. `npm run test:run`
8. `cargo test --manifest-path src-tauri/Cargo.toml --lib`
9. `npm run eval:agent` — the agent golden set, including the skill-selection cases

Then report:

- a gate table (gate, command, result)
- **version coherence**: releaseLabel, latest tag and Cargo version, and whether they
  agree — this is the check that broke `v0.1.6a`, so state it explicitly
- anything the release still needs (bundle smoke test, `gh release create`, assets)
- blockers, as a blunt list

Do not create a tag or a release in this command. This is verification only.
