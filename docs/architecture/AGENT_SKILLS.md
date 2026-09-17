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

## 6. Learning loop (P9)

Implementation: `src/components/AISlidePanel/ai-agent-learning.ts` (proposals + applier),
`src/stores/agent-learning-store.ts`, `src/components/AISlidePanel/AIAgentLearnings.tsx`.

A finished run can teach the workspace three things, and all three are **offered, never taken**:

| Artifact       | Command                         | Scope                                       |
| -------------- | ------------------------------- | ------------------------------------------- |
| Memory         | `save_agent_memory`             | the connection/database the run read        |
| Guardrail rule | `save_agent_rule`               | global — rules have no per-database variant |
| Skill          | `create_ai_skill` (with `body`) | global                                      |

`proposeRunLearnings({ insights, steps })` is pure and model-free, and what it may propose is
bounded by evidence exactly as insights are:

- a **rule** only when the finding names a plain-identifier column (nothing else can be matched
  literally), always `pre_read` + `warn`: a guardrail learned from an observation informs, and must
  never be able to refuse work the user asked for;
- a **memory** for the strongest findings, carrying the executed statement, the row count and the
  computed confidence, so the saved note is checkable;
- a **skill** only for a run of at least `MIN_SKILL_STEPS` steps that ended without a tool error and
  executed at least one read — model reasoning is not a repeatable procedure, so it is not written
  down as one.

The user approves each card; `applyLearningProposal` takes an injected invoker (so the command
mapping is unit-tested without a Tauri runtime), retires the card on success and announces the
written path in a toast. **Nothing in this path runs SQL**, so a learned artifact can never act on
the database by itself — this is the deliberate difference from the `remember_term` tool, where the
model writes memory mid-run.

`save_agent_rule` (Rust, `agent_rules.rs`) is the write side of the guardrail pack and its safety
properties are the load-bearing part: the name must be a slug (it becomes the file stem), values are
flattened to one line (the frontmatter reader is line-based), and the rendered text must parse _and
compile_ back into the rule that was requested before anything is written. A rule whose file the
loader cannot compile is refused rather than installed inert, and an existing file is never
overwritten, so the loop cannot clobber a hand-authored guardrail.

## 7. Scheduled agent tasks (P10)

Implementation: `src-tauri/src/storage/schedule_storage.rs` (row model + outcome write-back),
`src-tauri/src/commands/schedule.rs` (the tick, dispatch and `complete_agent_schedule_run`),
`src/stores/agent-schedule-store.ts` (the app-side queue),
`src/components/AISlidePanel/hooks/use-agent-schedule-runner.ts` (the runner),
`src/components/AISlidePanel/ai-agent-unattended.ts` (the read-only policy),
`src/components/AISlidePanel/ai-agent-schedule-outcome.ts` (what a run reports).

A schedule has a `kind`. `sql` (the default, and what legacy rows get) is executed by the Rust tick.
`agent` is **not executed by the backend at all**: the tick dispatches the trigger, writes the row as
`dispatched` and waits, because the agent loop is a React hook and therefore belongs to the app.

### Dispatch is not a run

| Step       | Owner                       | Durable effect                                                                                                                            |
| ---------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| interval   | Rust tick                   | `schedule-fired { kind: "agent", status: "dispatched", prompt, connectionId, database }`; row → `dispatched`, stale summary/error cleared |
| queued     | `agent-schedule-store`      | none (RAM queue); the schedules panel shows `waiting`                                                                                     |
| run starts | `use-agent-schedule-runner` | RAM only                                                                                                                                  |
| run ends   | runner → command            | row → `ok`/`needs_human`/`error` with `last_summary`/`last_error`                                                                         |

`complete_agent_schedule_run` refuses a row that is not `kind: agent`, and refuses a status the
scheduler owns: `dispatched` is written by the tick alone, so a stale — or invented — report can never
overwrite a row a SQL run owns, and a run can never leave its own trigger looking unanswered. Three
real outcomes are accepted:

- `ok` — the run answered;
- `needs_human` — the run reached for something only a person may do (it wanted to ask a question, or
  to write), was refused, and reported what it did find. Deliberately neither "failed" nor "succeeded";
- `error` — the run threw.

`last_rows` stays null for an agent run: one run may read many times, and a row count would then be a
number nobody measured, which reviewers treat as a bug.

A dispatch the app never answers keeps saying `dispatched` ("outcome not reported back yet"), and the
queue is RAM-only on purpose: after a restart the row is still `dispatched` and stays honest, whereas
resurrecting a queue from disk would claim work the app never did. A queued task that cannot start is
shown with its reason (pinned to another connection, another database, or the panel is busy) — the UI
never presents an undispatched task as a success. The four visible states are distinct on purpose:
`…` dispatched, `?` needs you, `⚠` failed, `✓` ran.

### Read-only, enforced three times

`unattendedReadOnly` rides the whole run and is enforced independently in three places, so no single
gap can let a write through:

1. **native tool payload** (`tool-schema/provider-formats.ts` → `tool-schema/parsing.ts`) — a blocked
   tool is absent from what the model can call;
2. **prompt-text catalog** (`ai-agent-context.ts`) — the same tool is absent from the text a
   non-native provider reads;
3. **executor** (`ai-agent-tool-executor.ts`) — a blocked tool that is named anyway is refused with a
   corrective observation and recorded in `getUnattendedBlockedTools()`.

The allow-list is `UNATTENDED_READ_ONLY_TOOLS`; `UNATTENDED_BLOCKED_TOOLS` is derived by subtracting
it from the canonical name list in `tool-schema/constants.ts`, so a newly added tool lands on the
blocked side (fail-closed) until someone decides otherwise. `ask_user` is refused with "this run is
unattended — no human is present" wording, so the loop converges on reading and reporting instead of
stalling on a question nobody can answer.

A run records rather than writes: P8 insights and P9 learning proposals are produced from its own
trace, and neither is applied on the agent's authority. The report persisted on the row names every
refused tool call (`ai-agent-schedule-outcome.ts`), because a blocked step must never read as a step
that succeeded, and the run's own findings are clamped to `MAX_PERSISTED_SUMMARY_CHARS` (400) /
`MAX_PERSISTED_ERROR_CHARS` (500) on both sides.

### Limits (deliberate)

- **The app must be open and the AI panel must have been mounted.** A dispatch that arrives with no
  mounted panel stays queued and visible as waiting — never dropped, never reported as run.
- **A task never moves the workspace.** It runs only while its own connection/database is the active
  scope, so an unattended task cannot pull the app out from under the person using it.
- **One unattended run at a time**, and never while the user's own run is in flight.
- **Closing the AI panel cancels a run that is in flight** (pre-existing panel behaviour). The row then
  records an error saying the run was replaced, rather than claiming it finished.
- **No app-closed execution** and **no auto-applied learning**: proposals wait for a human.
