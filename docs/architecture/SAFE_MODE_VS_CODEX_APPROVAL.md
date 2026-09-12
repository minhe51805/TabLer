# Safe Mode vs. Codex approval policy

> Topic: design comparison / attribution note
> Scope: TableR SQL Safe Mode + agent autonomy vs. OpenAI Codex CLI sandbox + approval model
> Status: reference note

## Why this note exists

An earlier code review left one open question: is TableR's Safe Mode a
re-implementation of Codex's approval policy, and should the two be compared in
depth? This note is that comparison. Short answer: **TableR does not copy
Codex's approval engine.** It borrows only Codex's three-word posture
*vocabulary* (`read-only` / `workspace-write` / `full-access`) for a UI badge,
while the actual enforcement is a domain-specific SQL guard that is structurally
different from Codex's OS-sandbox + approval-policy design.

## The two systems at a glance

| | Codex CLI | TableR |
| :-- | :-- | :-- |
| Thing being gated | Local shell commands + file edits | SQL statements sent to a remote DB engine |
| Enforcement layer | OS-level sandbox (seatbelt / landlock / seccomp) | SQL parse + statement-kind/capability classification (`sqlparser`) |
| User-facing dials | 2 orthogonal: `sandbox_mode` + `approval_policy` | 2: Safe Mode level (0-5) + agent autonomy (review/smart/full) |
| Always-on floor | None — `danger-full-access` removes all boundaries | Capability guard: filesystem/network/OS SQL blocked at *every* tier |
| Authoritative check | CLI runtime / OS | Rust backend (`validate_sandbox_statement`); frontend regex is advisory only |

## Codex's model (two orthogonal dials)

Codex separates safety into two independent controls:

- **`sandbox_mode`** — the *technical boundary* (filesystem scope + network):
  - `read-only` — inspect/read only, no writes or command execution.
  - `workspace-write` — read/write and run routine commands, but only inside the
    active workspace + configured `writable_roots`/temp; outbound network off by
    default.
  - `danger-full-access` — removes the local sandbox entirely (full FS + network).
- **`approval_policy`** — the *behavioral trigger* (when to pause for a human):
  - `on-request` — run routine actions automatically, pause when crossing a
    boundary (write outside workspace, network).
  - `never` — never prompt (CI / non-interactive).
  - (`untrusted` retired; `on-failure` deprecated.)

Common presets combine the two axes: **Read Only** = `read-only` + `on-request`;
**Auto** (default) = `workspace-write` + `on-request`; **Full Access** =
`danger-full-access` + `never`.

## TableR's model

TableR also has two dials, but they are shaped for SQL risk rather than an OS.

### Dial 1 — Safe Mode level (`src-tauri/src/utils/safe_mode.rs`, `src/types/safe-mode.ts`)

A six-step gradient over SQL *statement kind*, not a filesystem scope:

| Level | Label | Effect |
| :-- | :-- | :-- |
| 0 | Disabled | Statement-kind guard off (capability guard still on) |
| 1 | Read Only | Only SELECT/SHOW/EXPLAIN/WITH; all writes blocked |
| 2 | Low Risk | SELECT + INSERT only; UPDATE/DELETE blocked |
| 3 | Standard | INSERT/UPDATE/DELETE need confirmation; DROP/TRUNCATE/ALTER (except RENAME COLUMN)/CREATE TABLE blocked |
| 4 | Strict | Confirmation for all writes; DROP/TRUNCATE/CREATE TABLE hard-blocked |
| 5 | Paranoid | Confirmation for SELECT and all writes; preview + estimated affected rows |

Human approval (`assert_sql_allowed_at_level_with_approval`) only relaxes the
**write/DDL block at levels 1-3**. The always-blocked family
(DROP/TRUNCATE/CREATE TABLE) stays blocked at levels 4-5 *regardless of any
approval flag*. There is no user-selectable escape hatch that runs a DROP under
Strict/Paranoid.

### Dial 2 — agent autonomy (`src/components/AISlidePanel/ai-execution-policy.ts`)

Governs *when the AI agent runs SQL without a per-statement dialog*:

- `review` — always show the review dialog (never auto-run).
- `smart` — auto-run safe reads, confirm every write/high-risk statement.
- `full` — standing human approval; reads and writes run without a dialog. The
  invariant `fullAutonomyPreApproved = autonomy === "full" && safeModeLevel <= 3`
  means this standing grant only covers levels 1-3.

### Always-on floor — the capability guard (`detect_dangerous_capability`, `validate_sandbox_statement`)

A fail-closed guard runs **first**, before statement-kind classification, and
blocks filesystem/network/OS-command SQL even when it parses as a plain read:
`pg_read_file`/`pg_ls_dir`/`lo_import`/`lo_export`, MySQL `LOAD_FILE`/`INTO
OUTFILE`/`LOAD DATA INFILE`, DuckDB `read_csv`/`read_parquet`/`glob`/`write_*`,
Postgres `COPY ... TO/FROM PROGRAM`, MSSQL `xp_cmdshell`/`openrowset`, etc. The
sandbox also requires exactly one statement per item and blocks session/access
control (USE, ATTACH, SET search_path, transactions, GRANT/REVOKE). **This guard
has no bypass — it applies even at Safe Mode level 0.**

## The bridge: `resolveSandboxPolicy`

`resolveSandboxPolicy(safeModeLevel, autonomy)` collapses TableR's two dials into
Codex's three-word vocabulary, **for display only** (it changes no behavior):

```
level <= 0                          -> "full-access"
autonomy === "full" && level <= 3   -> "workspace-write"
otherwise                           -> "read-only"
```

`describeSandboxPolicy` supplies the badge label + tooltip. This is the *only*
place TableR speaks Codex's language, and it is a diagnostic summary of controls
the app already enforces.

## Side-by-side mapping

| Codex preset | Codex dials | Nearest TableR posture | Resolved badge |
| :-- | :-- | :-- | :-- |
| Read Only | `read-only` + `on-request` | Safe Mode >= 1 with autonomy smart/review (or full at levels 4-5) | `read-only` |
| Auto | `workspace-write` + `on-request` | Safe Mode 1-3 + autonomy `full` (standing grant) | `workspace-write` |
| Full Access | `danger-full-access` + `never` | Safe Mode 0 (Disabled) — **but capability guard still on** | `full-access` |

## Where they align

- Both split "what boundary applies" from "when to ask a human." Codex does it
  with two config dials; TableR does it with Safe Mode level (boundary/risk) plus
  autonomy (approval cadence).
- `autonomy: full` at levels 1-3 behaves like Codex **Auto**: routine writes run
  without a prompt inside a bounded scope.
- `autonomy: smart` behaves like **on-request**: safe reads auto-run, writes pause.
- The UI badge deliberately reuses Codex's `read-only`/`workspace-write`/
  `full-access` labels so users familiar with Codex read the posture instantly.

## Where they diverge (the important part)

1. **Enforcement substrate.** Codex sandboxes *local* processes at the OS level.
   TableR cannot sandbox a remote DB server, so it gates at the SQL layer: parse
   the statement, classify its kind and capability, decide before it crosses the
   boundary. Different problem, different mechanism.
2. **Granularity.** Codex has 3 sandbox values and 2 approval values. TableR's
   Safe Mode is a 6-level SQL-risk gradient that distinguishes read < insert <
   update/delete < non-destructive DDL < DROP/TRUNCATE — distinctions a generic
   coding agent has no reason to make.
3. **No true `danger-full-access`.** This is the sharpest difference. Codex's
   Full Access removes *all* boundaries. TableR's resolved `full-access` badge
   only means the *statement-kind* guard is off; the filesystem/network/OS
   capability guard still runs. There is no TableR setting that lets SQL read
   `/etc/passwd` or shell out. TableR borrowed Codex's word, not its escape hatch.
4. **Human approval can't unlock destructive DDL at strict tiers.** At levels
   4-5, DROP/TRUNCATE/CREATE TABLE are hard-blocked even with explicit approval —
   there is no "I accept the risk" override, unlike Codex's `never` + full-access.
5. **Two-layer enforcement.** TableR's frontend regex is a fast advisory path;
   the Rust `sqlparser`-based backend is authoritative and is the last line of
   defense (it catches mutating CTEs the frontend regex misreads). Codex's
   enforcement lives in the runtime/OS.

## Conclusion

TableR's Safe Mode is not a port of Codex's approval policy. The overlap is
intentional and narrow: a shared *conceptual split* (boundary vs. approval
cadence) and a *borrowed three-word vocabulary* used only for a display badge
via `resolveSandboxPolicy`/`describeSandboxPolicy`. The enforcement itself — a
6-level SQL statement-kind gradient, a level-gated human-approval flow, and an
always-on, bypass-free filesystem/network/OS capability denylist enforced by a
SQL parser in the Rust backend — is domain-specific to TableR's database use
case and is, on the capability axis, strictly more conservative than Codex
(no `danger-full-access` equivalent).

## Source references

- `src-tauri/src/utils/safe_mode.rs` — level policy + approval relaxation.
- `src-tauri/src/utils/sql.rs` — `classify_sql_with_dialect`, `detect_dangerous_capability`.
- `src-tauri/src/commands/query.rs` — `validate_sandbox_statement` / `validate_sandbox_batch`.
- `src/types/safe-mode.ts` — level labels + frontend advisory patterns.
- `src/components/AISlidePanel/ai-execution-policy.ts` — autonomy, `resolveSandboxPolicy`, `describeSandboxPolicy`.
