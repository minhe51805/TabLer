---
description: Guided feature development in this repo — explore, clarify, design options, get approval, then implement
argument-hint: Optional feature description
allowed-tools: ["Read", "Grep", "Glob", "Task", "Bash", "Edit", "Write"]
---

# Feature Development (TableR)

You are implementing a feature in the TableR repository. Follow the seven phases below.
**Do not skip phase 3, and do not begin phase 5 without explicit approval.**

## Context

- Status: !`git status --short`
- Branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -5`
- Project conventions: read `AGENTS.md` before anything else.

## Phase 1 — Discovery

Goal: know what is being built.

1. Read `AGENTS.md` for the stack, commands and hard-won facts.
2. Create a todo list covering all seven phases.
3. Restating the request in your own words: problem, desired behaviour, constraints.
4. If any of those is unclear, ask before exploring.

## Phase 2 — Codebase exploration

Goal: understand the existing shape at both levels.

Launch **2–3 `code-explorer` agents in parallel**, each on a different axis, and ask each
to return a reading list:

- "Trace how <similar feature> works end to end, including the Tauri boundary"
- "Map the architecture and abstractions for <area>, and list the invariants"
- "Identify the extension points, tests and fixtures relevant to <feature>"

Then **read the files they named** before going further.

## Phase 3 — Clarifying questions (do not skip)

Goal: remove every ambiguity before designing.

1. List the underspecified aspects: edge cases, error handling, integration points,
   scope boundaries, backward compatibility, performance, migration, and which layer
   owns the decision.
2. Present the questions as a numbered list.
3. **Wait for answers.** If the answer is "whatever you think is best", state your
   recommendation and get explicit confirmation.

## Phase 4 — Design options

Goal: make the trade-off visible before committing.

1. Use **2–3 `code-explorer` agents in parallel**, each with a different bias:
   smallest change, cleanest abstraction, pragmatic balance.
2. Present: a summary of each option, the trade-off table, **your recommendation with
   reasoning**, and the concrete difference in files touched.
3. **Ask which option to build.** Do not proceed on silence.

## Phase 5 — Implementation

**Only after explicit approval.**

1. Re-read the files identified earlier.
2. Implement the chosen option, matching surrounding conventions.
3. Keep the todo list current.
4. Run the narrowest checks as you go: `npm run typecheck`, the touched test file,
   `cargo check --manifest-path src-tauri/Cargo.toml`.
5. Touch a skill/rule/command file → run `npm run check:agent-skills`.
6. Never change a prompt string, a tool schema, a cap value or a frontmatter key as a
   side effect of an unrelated change.

## Phase 6 — Quality review

Launch **3 review agents in parallel**, each with a different focus:

- `agent-eval-coverage` — what fails if this regresses
- `silent-failure-hunter` — swallowed errors and ambiguous successes
- one specialist matching the change: `tsql-reviewer`, `sql-injection-auditor`,
  `schema-migration-risk`, or `comment-analyzer`

Then consolidate: only findings at confidence ≥ 80 go in your report. Present them and
**ask what to do** — fix now, later, or proceed. Run `code-simplifier` only after the
findings are resolved.

## Phase 7 — Verification and summary

1. Run the gates: `npm run check:frontend`, and for Rust changes
   `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.
2. Report: what was built, the decisions made and why, files changed, checks run with
   their results, and what remains.

Never claim a check passed unless you ran it in this session.
