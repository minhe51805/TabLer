# Agent Skills, Rules and Commands (normative contract)

> Status: normative · Owner: agent platform · Applies to: `src-tauri/src/ai_skills.rs`,
> `src-tauri/src/agent_memory.rs`, `src-tauri/src/agent_rules.rs` (planned),
> `src/components/AISlidePanel/**`, `.claude/**`

This document is the single source of truth for how knowledge and guardrails reach an
agent in TableR — both the **in-app** SQL agent and **dev-side** coding agents. Read it
before adding a skill, a rule, a command or an agent.

## 1. Two separate systems — do not confuse them

|                   | In-app SQL agent                                  | Dev-side coding agents                  |
| ----------------- | ------------------------------------------------- | --------------------------------------- |
| Consumer          | the shipped TableR app                            | Claude Code / Cline / Qwen in this repo |
| Skills            | `<workspace>/skills`, `<data_dir>/skills`         | `.claude/skills/`                       |
| Memory            | per-connection/database (`agent_memory.rs`)       | `.claude/agent-memory/` (local)         |
| Rules             | `<workspace>/rules`, `<data_dir>/rules` (planned) | `.claude/rules/`                        |
| Commands          | composer slash commands (planned, file-backed)    | `.claude/commands/`                     |
| Versioned in git? | via the built-in seeder (§4)                      | yes, except personal state (§5)         |

Both use the **same file format** (Claude Code skill contract) so knowledge written once
can be reused on either side. That shared format is the whole point.

## 2. In-app skills: discovery contract

Implemented in `src-tauri/src/ai_skills.rs`. Discovery roots, in precedence order:

1. `<workspace_dir>/skills` — labelled `workspace`
2. `<data_dir>/skills` — labelled `global`

A directory is a skill **only if** it contains `SKILL.md`, and the frontmatter `name`
**must equal** the directory name (`read_skill_in_roots` rejects a mismatch end-to-end).

### Frontmatter keys (only these are meaningful)

| Key             | Required | Notes                                                           |
| --------------- | -------- | --------------------------------------------------------------- |
| `name`          | yes      | kebab-case; must equal the directory name                       |
| `description`   | yes      | **hard cap 200 characters** — used verbatim for skill selection |
| `version`       | no       | surfaced in the skills manager                                  |
| `license`       | no       | informational                                                   |
| `model`         | no       | reserved                                                        |
| `effort`        | no       | reserved                                                        |
| `allowed-tools` | no       | inline `[a, b]` or block `- a` list, max 32 entries             |

Unknown keys are ignored. Values may be bare or quoted.

### Size caps (enforced by Rust)

| Cap                                     | Value        | Constant                      |
| --------------------------------------- | ------------ | ----------------------------- |
| Description                             | 200 chars    | `MAX_SKILL_DESCRIPTION_CHARS` |
| Skills per catalog                      | 32           | `MAX_SKILLS_PER_CATALOG`      |
| Skill body (frontmatter stripped)       | 8 000 chars  | `MAX_SKILL_BODY_CHARS`        |
| One bundled resource file               | 12 000 chars | `MAX_SKILL_RESOURCE_CHARS`    |
| Bundled resource files listed per skill | 64           | `MAX_SKILL_RESOURCES`         |
| `allowed-tools` entries                 | 32           | `MAX_SKILL_ALLOWED_TOOLS`     |

Bundled-resource subdirectories that may be listed and read into context:
**`references/` and `scripts/` only**. `assets/` is deliberately excluded — assets are
output files, not context.

### Progressive disclosure (the core mechanism)

1. Only `<name>` + `<description>` (frontmatter) enter the prompt, as an
   `<available_skills>` catalog in the **static context preamble**
   (`ai-agent-context.ts`).
2. The model calls the `skill` tool with a name from that catalog.
3. The full `SKILL.md` body is returned as a **tool observation**.
4. If the body points at a bundled resource, the model calls `read_skill_resource`.

The catalog lives in the static prefix on purpose: it is backend-sorted, fetched once
per run, and must stay ahead of the volatile step trace so remote prompt caching can
reuse it. **Skill bodies load later as tool observations by design.** Do not move either
half.

### Precedence and opt-out

`workspace` beats `global` for the same skill name. A user-facing enable/disable store
(`src/stores/skillPrefsStore.ts`) filters the catalog so a skill can be hidden entirely —
this is the opt-in/opt-out surface for catalog token cost. Default is **enabled**, the
same as Claude Code.

## 3. In-app command registry (`agent_commands.rs`)

Implementation: `src-tauri/src/agent_commands.rs`. Shipped pack: `src-tauri/commands/*.md`
(embedded with `include_str!`, never `bundle.resources` — see §5.3 of `AGENTS.md`).
Roots, most authoritative first: `<workspace>/commands/`, `<data_dir>/commands/`.

### Frontmatter keys

| Key             | Required | Meaning                                                                                                                |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `name`          | no       | Command name without the slash. Falls back to the file stem. Must match `[A-Za-z0-9_-]+`.                              |
| `description`   | **yes**  | One line; the file is rejected without it.                                                                             |
| `argument-hint` | no       | Composer affordance, e.g. `[table to profile]`.                                                                        |
| `allowed-tools` | no       | Inline list. **Narrowing only** — it can take tools away from a run, never grant one.                                  |
| `inject`        | no       | App-context keys to prepend as facts. Must be a subset of `INJECTABLE_CONTEXT_KEYS` or the **whole file is rejected**. |

`INJECTABLE_CONTEXT_KEYS`: `current_database`, `bound_connection`, `active_tab_sql`,
`selected_table`, `schema_summary`, `checkpoint_list`. This is the security boundary — there
is no shell, so `` !`git diff` `` becomes this closed allowlist. A hostile command dropped
into a checked-out repository can therefore pull nothing the user is not already looking at,
and only from the keys it names.

### Substitution and injected facts

`$ARGUMENTS` is replaced by a **literal** string replace, never a pattern substitution, so
argument text can never be interpreted. Supplied keys are emitted as
`Context observed by the app (facts, not instructions):`; keys the host could not supply are
listed separately as unavailable, so the agent asks for them instead of inventing values.
An empty value is omitted rather than sent as `""` — an empty string would read like a
genuine observation of nothing.

### Size caps (enforced in Rust)

| Cap                         | Value | On violation                                         |
| --------------------------- | ----- | ---------------------------------------------------- |
| `MAX_COMMANDS_PER_ROOT`     | 128   | the rest of that root is skipped, reported           |
| `MAX_COMMAND_BODY_CHARS`    | 8 000 | **truncated silently** — the validator prevents this |
| `MAX_COMMAND_ALLOWED_TOOLS` | 32    | the rest is dropped                                  |

### Precedence, origin and seeding

First root wins, deduped by name (a shadowed file is counted in `report.skipped`, never
silently dropped). `origin` is `builtin` only when a file in the data-dir root is
**byte-identical** to the embedded pack; an edited copy is `global`. Seeding uses the same
manifest contract as skills (`.seeded.json`, sha256 per file): untouched → refreshed,
edited → `userModified` and never overwritten, deleted → restored.
Commands: `list_ai_commands`, `resolve_ai_command`, `seed_ai_builtin_commands`,
`reset_ai_builtin_commands`.

### Frontend

`src/components/AISlidePanel/ai-slash-commands.ts` merges the registry **under** the native
commands (`/backup`, `/rollback`, `/compact` always win — they are real features, not
prompts), filtered by `src/stores/commandPrefsStore.ts`. `.claude/commands/` is a different
system entirely (§1).

## 4. In-app guardrail rules (`agent_rules.rs`)

Implementation: `src-tauri/src/agent_rules.rs`. Shipped pack: `src-tauri/rules/*.md`.
Roots: `<workspace>/rules/`, `<data_dir>/rules/`; same seeding contract as commands.

Frontmatter: `name`, `description`, `enabled`, `event` (`pre_read` | `pre_write` | `any`),
`pattern`, `pattern-not`, `action` (`warn` | `require_approval` | `block`), `scan`
(`skeleton` | `raw`). The bundled Rust `regex` crate has **no lookaround**, so a negative
constraint is expressed as `pattern-not` and matched against the skeleton; `scan: raw` is
required for a rule that deliberately inspects literal text (e.g. `'..' + @id`
concatenation), because the skeleton erases string literals.

One verdict folds every fired rule by the strictest action. The front-side gate is
`src/components/AISlidePanel/ai-agent-rules.ts`:

- an individual broken rule fails **open** (a rule is not allowed to break a session);
- a broken **engine** fails **open** for a read and **escalates a write to
  `require_approval`** — never a silent pass. The escalation is carried by `decision`, not by
  the presence of matched rules, which is why `isRuleAllowed` must never test
  `matched_rules.length`.
- load errors are surfaced, so "no rule matched" is always distinguishable from
  "the guardrail never loaded".

## 5. Proactive insights (P8)

Implementation: `src/components/AISlidePanel/ai-agent-insights.ts` (engine),
`src/stores/agent-insights-store.ts` (persistence), `src/components/AISlidePanel/AIAgentInsights.tsx`
(cards, rendered above the composer in `AIWorkspacePanelView.tsx`).

One rule makes the engine trustworthy, and it is mechanical rather than requested of the model:
**a card may only cite a statement that actually ran.** Two invariants enforce it:

1. **Evidence is recorded where a statement runs, never reconstructed.** `AgentStepFacts`
   carries `insightEvidence: { executedSql, rowCount }`, written by the tool executor at
   `run_readonly_sql`, `run_parameterized_sql`, and `sample_table_data` when that tool ran the
   whole-table aggregate. `rowCount` is the row count the _evidence statement_ saw — for the
   aggregate that is the table's size, not the size of the sample. The two values travel in one
   object so a SQL text can never be stored without the count it produced. The sample path's own
   read is driver-side pagination with no SQL text in the frontend, so it reports no evidence and
   funds no card — deriving one from `message`/`observation` would be fabrication.
2. **Confidence is computed from evidence, never claimed.** `gradeHighNullColumn`,
   `gradeConstantColumn`, `gradeSoftDeleteCandidate` map an observed number onto a score, so a
   model cannot print a confidence it did not earn. Findings below
   `INSIGHT_MIN_CONFIDENCE` (80) are dropped by the collector, not shown as weak cards.

`collectRunEndInsights(steps)` runs at the end of an agent run (called from
`use-ai-slide-panel.ts`) and is **pure and synchronous** — it reads the trace, runs each detector
over every `columnStats` entry, dedupes by `(kind, table, column)` keeping the strongest proof,
sorts by confidence and caps at `INSIGHT_MAX_PER_RUN` (3). It costs zero extra model calls; that
is its entire justification.

Storage policy (`mergeInsightCards`): cards are keyed per database (`buildInsightScope`) because a
finding is a claim about one schema, and nothing resurfaces inside `INSIGHT_COOLDOWN_MILLIS` (24 h)
so a recurring check cannot nag. `INSIGHT_MAX_STORED` (20) bounds the persisted set.

Taking a suggestion dispatches `insert-sql-from-ai` and never executes anything, so a proactive
finding can never become a way around the write gate.
