---
name: tsql-safety-guardrails
description: This skill should be used when the user asks to "delete rows", "update data", "drop or truncate a table", "clean up data", or any request that would modify the database.
version: 1.0.0
license: MIT
---

# SQL Safety Guardrails

Load this for **any** request that mutates data or schema. The contract is simple: a
mutation is never the first thing that happens. Evidence first, then the write, then a
verification that the write did what was intended.

## Non-negotiable rules

1. **Prove the target set before changing it.** For every `UPDATE` or `DELETE`, first run
   the equivalent `SELECT` with the exact same `WHERE` clause and report the row count.
   A mutation whose row count was never observed is not an answer, it is a gamble.
2. **A `WHERE`-less `UPDATE`/`DELETE` is only allowed when the user's own words ask for
   the whole table** (e.g. "wipe the staging table"). Otherwise refuse and ask — even if
   the table looks small. Say what you would do and what the row count would be.
3. **Every write goes through `preview_write`.** State the expected row count in the
   preview so the user approves a number, not a sentence.
4. **Multi-statement writes are transactional.** Wrap them in
   `BEGIN TRAN … COMMIT` and keep a rollback path. Never leave a script that can
   half-apply.
5. **No destructive DDL unless explicitly requested by name.** `DROP`, `TRUNCATE`,
   `ALTER … DROP COLUMN`, and `sp_rename` require the user to have named the operation.
   "Clean up the schema" is not a request to drop anything.
6. **Never enable server-side escalation.** Do not emit `xp_cmdshell`, `OPENROWSET(BULK …)`,
   `sp_configure`, `EXEC … WITH RECOMPILE + linked server writes`, or cross-database
   writes. If a task genuinely needs one of these, explain why and stop — do not try.

## Recommended sequence for a mutation

```
1. describe_table            → confirm columns, types, nullability, keys
2. run_readonly_sql          → SELECT with the same WHERE; report row count
   (or find_value/sample_table_data when the predicate is a value lookup)
3. verify assumptions        → uniqueness for UPDATE…FROM JOIN (gotcha #10),
                               NULLs for NOT IN (gotcha #1)
4. propose a checkpoint      → suggest /backup when the row count is material
5. preview_write             → show the statement + expected row count
6. execute after approval
7. verify                     → re-run the SELECT from step 2; the numbers must agree
```

Step 7 is what makes the answer trustworthy. "Updated 0 rows" is a finding, not a
silent success — report it.

## Scoping the blast radius

- Prefer key-list deletes over predicate deletes when the set is small and already
  known: `DELETE FROM t WHERE id IN (…)` makes the exact affected rows auditable.
- Use `TOP (n)` to sample before an unbounded operation, but remember `DELETE TOP (n)`
  has no `ORDER BY` — select keys first, then delete by key.
- For a large bulk change, batch it (`WHILE` loop over a key range) instead of one
  statement: it keeps transactions short and the operation interruptible.
- Take a checkpoint (`/backup`) before a change whose rollback would otherwise be
  manual reconstruction.

## Schema changes

- Additive first: `ADD COLUMN` nullable or with a `DEFAULT`; never add a `NOT NULL`
  column without a default to a table with rows.
- Keep DDL idempotent so a re-run is safe — see the `migration-authoring` skill for
  guard patterns (`IF OBJECT_ID(...) IS NULL`, `COL_LENGTH(...) IS NULL`).
- Adding a `NOT NULL` constraint or an index can lock the table; state that cost when
  the table is large (check the row count from `sys.dm_db_partition_stats`).
- Dropping a column that an index, constraint, or view depends on fails — check
  dependencies (`sys.sql_expression_dependencies`) first and report them.

## When the request is ambiguous, ask

Use `ask_user` when any of these is true, and ask **before** doing anything else:

- The predicate is not precise enough to bound the rows ("inactive users" — by what
  column and threshold?).
- The target could plausibly be a different table, schema, or database.
- The operation is irreversible and the row count is unknown.
- The user's request would require disabling a guardrail.

Provide a concrete recommendation with each question ("I read 'inactive' as
`last_login_at < DATEADD(month, -6, SYSUTCDATETIME())` — confirm or correct").

## What to report after a write

Report these four facts, always: the statement that ran, the row count observed in
preview, the row count actually affected, and the verification query result. A write
reported without the affected-row count is an unverified claim.

## See also

- The `tsql-dialect-mastery` skill — correctness traps, including the `MERGE` and
  `UPDATE … FROM` hazards referenced above.
- The `data-profiling` skill — the read-only profiling queries used in step 2.
- The `migration-authoring` skill — idempotent DDL for the schema-change path.
