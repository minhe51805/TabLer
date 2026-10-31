# Engine matrix — the safety workflow, translated per engine

Companion to the `tsql-safety-guardrails` skill. The workflow (prove the target set →
preview → execute → verify) is engine-independent; this file translates the vocabulary.
When the bound engine is not in this table, apply the closest row and say so explicitly
in the answer.

## The matrix

| Concern                             | SQL Server                                         | PostgreSQL                 | MySQL / MariaDB                                                            | SQLite                              | DuckDB                          |
| ----------------------------------- | -------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------- | ----------------------------------- | ------------------------------- |
| Transaction start                   | `BEGIN TRAN;`                                      | `BEGIN;`                   | `START TRANSACTION;`                                                       | `BEGIN;`                            | `BEGIN;`                        |
| DDL inside a transaction            | Yes                                                | Yes                        | **MySQL: no** — DDL commits implicitly; MariaDB: same                      | Yes                                 | Yes                             |
| Affected rows from the write itself | `OUTPUT` clause (limit: triggers), or `@@ROWCOUNT` | `RETURNING`                | Affected-rows count; `ON DUPLICATE KEY` reports 1 per insert, 2 per update | `RETURNING` (3.35+)                 | `RETURNING`                     |
| Identifier quoting                  | `[brackets]` (or `""` with QUOTED_IDENTIFIER)      | `"double quotes"`          | `` `backticks` ``                                                          | `"double quotes"`                   | `"double quotes"`               |
| Destructive guard                   | `IF OBJECT_ID(…) IS NOT NULL`                      | `DROP … IF EXISTS`         | `DROP … IF EXISTS`                                                         | `DROP … IF EXISTS`                  | `DROP … IF EXISTS`              |
| Whole-table delete equivalent       | `TRUNCATE TABLE`                                   | `TRUNCATE` (transactional) | `TRUNCATE` (implicit commit, can't roll back)                              | **No `TRUNCATE`** — `DELETE FROM t` | No `TRUNCATE` — `DELETE FROM t` |
| Verify-after-write shape            | Re-run the step-2 `SELECT`; counts must agree      | Same, or read `RETURNING`  | Same                                                                       | Same                                | Same                            |

## Per-engine notes the table cannot hold

- **SQL Server.** `DELETE TOP (n)` has no `ORDER BY` — select keys first, then delete by
  key list, or the wrong rows can go. `TRUNCATE` cannot run when the table is referenced
  by an enabled FK; it also resets identity seeds.
- **PostgreSQL.** A failed statement aborts the whole transaction — every later
  statement errors until `ROLLBACK`, so verification queries must come after the commit
  or after the rollback, not after a failed write. `TRUNCATE` is transactional but takes
  an ACCESS EXCLUSIVE lock.
- **MySQL.** DDL is an implicit commit: a migration that mixes `ALTER TABLE` with data
  writes has no single rollback path — stage DDL and DML as separate transactions (see
  `migration-authoring`). `sql_mode` matters: with `ONLY_FULL_GROUP_BY` (default since
  5.7) non-aggregated columns must be in `GROUP BY`; on legacy servers the same query
  silently returns an arbitrary row. Charset deltas: `utf8` on MySQL is really `utf8mb3`
  (3 bytes, no emoji) — use `utf8mb4`; and a JOIN between columns with **different
  collations** cannot use the index on one side — check both column collations when a
  join unexpectedly scans.
- **SQLite.** Foreign keys are off per connection (`PRAGMA foreign_keys = ON`), so a
  `DELETE` that "cascades" may cascade nowhere until that pragma is set — verify with
  `PRAGMA foreign_keys` before claiming children were removed. Altering anything beyond
  add-column/rename needs the twelve-step rebuild (see `migration-authoring`).
- **DuckDB.** In-process and column-oriented, aimed at analytics; treat bulk `DELETE`
  plus re-insert as the shape for rewrites, and check `table-stats` sizing before and
  after — DuckDB files do not shrink without a `CHECKPOINT`/rebuild, so a "successful"
  delete that reports rows-affected may leave the file the same size on disk.

## Row counts you cannot verify — refuse, don't guess

The workflow's step 7 (verification) is only possible where an affected-row count can be
read back. In this app the agent's write path already reports affected rows through
`preview_write`; for engines whose access layer cannot report an affected count for the
statement shape in question, **stop and say so** — "this write cannot be verified" is a
finding, not a failure to be papered over. A write reported without a verification
number is exactly the unverified claim the safety contract forbids.

## Charset and collation, anywhere it applies

- Prefer explicit `utf8mb4`-equivalent settings on any engine where the server default
  is legacy (`latin1`-era MySQL 5.7, `SQL_Latin1_General_CP1`-style SQL Server
  collations for non-Unicode columns). VARCHAR, not NVARCHAR, on SQL Server means the
  code page decides what survives.
- Collation mismatch is a correctness bug, not just a performance bug: two columns
  comparing equal visually can compare unequal at join time — when a join both scans
  and drops rows unexpectedly, check collations before suspecting the data.
