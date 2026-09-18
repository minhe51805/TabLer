---
description: Multi-aspect review of the current diff using the TableR specialist agents
argument-hint: "[aspects] — comments|tests|errors|types|sql|code|simplify|all"
allowed-tools:
  ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git status:*)", "Bash(gh pr view:*)", "Task"]
---

# Multi-aspect review

Aspects requested: "$ARGUMENTS" (default: `all`).

## Context

- Status: !`git status --short`
- Changed files: !`git diff --name-only HEAD`
- Diff size: !`git diff --stat HEAD | tail -1`

## 1. Determine the review scope

- Default scope is the **unstaged + staged diff against HEAD** (`git diff HEAD`). If the
  user names a PR, use `gh pr view --json files` instead.
- Save the changed-file list first; it decides which aspects apply.

## 2. Pick applicable aspects

| Aspect      | Agent                                                                         | Applies when                                                               |
| ----------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `code`      | `code-reviewer` (always)                                                      | always — general quality against `AGENTS.md`                               |
| `sql`       | `tsql-reviewer`                                                               | any `.sql`, or `src-tauri/src/**` query building, or `src-tauri/skills/**` |
| `errors`    | `silent-failure-hunter`                                                       | error handling, `catch`, `Result`, fallbacks changed                       |
| `types`     | `type-design-analyzer`-style pass — run it as an aspect, not a separate agent | new/changed types, `src/types/**`                                          |
| `tests`     | `agent-eval-coverage`                                                         | `src/components/AISlidePanel/**` or agent behaviour changed                |
| `security`  | `sql-injection-auditor`                                                       | SQL construction, parameter binding, identifier interpolation              |
| `migration` | `schema-migration-risk`                                                       | DDL, migrations, schema files                                              |
| `comments`  | `comment-analyzer`                                                            | comments or docs added/changed                                             |
| `simplify`  | `code-simplifier`                                                             | only **after** the above pass, as polish                                   |

If `sql`, `errors`, `security` or `migration` applies, they take priority — a silent
failure or an injected identifier outranks a style nit.

## 3. Run the passes

Sequential by default (each report complete before the next, easier to act on). Run in
parallel only when the user asks for speed.

## 4. Report — use confidence scoring, and nothing else

Every finding carries:

- **confidence 0–100** using the shared rubric:
  `0–25` likely false positive or pre-existing · `26–50` nitpick not in `AGENTS.md` ·
  `51–75` valid, low impact · `76–90` important · `91–100` critical bug or explicit
  `AGENTS.md` violation
- **file path + line number**
- the specific rule (`AGENTS.md` section) or the bug mechanism — not "this looks bad"

**Only report findings with confidence ≥ 80.** List anything below 80 in a separate
one-line "suppressed" count, without detail. Silence is better than noise: a reviewer
that reports nitpicks gets ignored, and then the real finding is ignored too.

## 5. Aggregate

- **Critical / must fix before merge** — anything ≥ 91, plus every security or
  data-loss finding regardless of score.
- **Should fix** — 80–90.
- **Suppressed** — count only.

Then ask the user what to do: fix now, fix later, or proceed as-is. Do not start fixing
without that answer.
