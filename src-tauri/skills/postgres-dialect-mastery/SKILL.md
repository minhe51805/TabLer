---
name: postgres-dialect-mastery
description: This skill should be used when the user asks to "write PostgreSQL SQL", "use ON CONFLICT", "fix a RETURNING clause", or when the target engine is Postgres.
version: 1.0.0
license: MIT
---

# PostgreSQL Dialect Mastery

Load this when the bound engine is PostgreSQL. The traps below are the ones that make a
query fail outright or, worse, silently return the wrong rows.

## Upsert: `ON CONFLICT`, not `REPLACE`

```sql
INSERT INTO customer (id, email, updated_at)
VALUES (1, 'a@b.c', now())
ON CONFLICT (id) DO UPDATE
   SET email = EXCLUDED.email,
       updated_at = EXCLUDED.updated_at;
```

- `ON CONFLICT (col)` needs a **unique index** on `col`; without one it errors instead of
  guessing.
- `EXCLUDED` is the proposed row. Referencing the bare column name in `DO UPDATE` means
  _the existing row_, which is the classic silent-wrong-value bug.
- `ON CONFLICT DO NOTHING` swallows _every_ conflict, not just the key you had in mind.
- `INSERT OR REPLACE` is SQLite syntax and is not valid here.

## Returning data from a write

PostgreSQL can return the affected rows, which removes the need for a follow-up SELECT:

```sql
UPDATE orders SET status = 'shipped' WHERE id = 42 RETURNING id, status, updated_at;
DELETE FROM sessions WHERE expires_at < now() RETURNING id;
```

Use `RETURNING` to prove what a write touched rather than asserting it.

## Types, literals, and functions

| Need                                         | PostgreSQL                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| String literal escaping                      | `'it''s'`; **no** `N'...'` prefix — `N'x'` is an error                                         |
| Identifier quoting                           | `"quoted_name"` (double quotes); single quotes are _only_ strings                              |
| Boolean                                      | `true` / `false`, type `boolean` — no `1`/`0` column type                                      |
| Auto-increment                               | `GENERATED ALWAYS AS IDENTITY` (preferred) or `serial`/`bigserial`                             |
| Current time                                 | `now()`, `CURRENT_TIMESTAMP` (both `timestamptz`); `clock_timestamp()` for the true wall clock |
| Attention: `now()` is transaction start time | it does **not** change inside a transaction                                                    |
| String concat                                | `                                                                                              |     | `returns NULL if any operand is NULL — use`concat(a, b)` to ignore NULLs |
| Null handling                                | `coalesce`, `nullif`; `IS DISTINCT FROM` for NULL-safe inequality                              |
| Limit/offset                                 | `LIMIT n OFFSET m`, or `OFFSET m ROWS FETCH NEXT n ROWS ONLY`                                  |
| Regex                                        | `~`, `~*`, `!~`; `regexp_replace`, `regexp_match`                                              |
| JSON                                         | `jsonb` over `json`; `->` (json), `->>` (text), `@>`, `?`, `jsonb_path_query`                  |
| Arrays                                       | `ARRAY[...]`, `= ANY(arr)`, `unnest(arr)`                                                      |
| Casting                                      | `CAST(x AS int)` or `x::int` — `::` is PostgreSQL-only                                         |
| String agg                                   | `string_agg(col, ', ' ORDER BY col)`                                                           |
| Top-N per group                              | `DISTINCT ON (grp) ... ORDER BY grp, ts DESC`, or `row_number() OVER (PARTITION BY ...)`       |

## Dates and intervals

```sql
WHERE created_at >= now() - interval '7 days'
WHERE created_at >= date_trunc('month', now())
SELECT created_at + interval '1 day' AS tomorrow
```

There is no `DATEADD`/`DATEDIFF`. Use `age(a, b)` or subtract timestamps to get an
interval, and `extract(epoch FROM a - b)` for seconds. `date_trunc` is the idiomatic
period bucketing function.

## Concurrency and safety

- Wrap multi-statement writes in `BEGIN; … COMMIT;` and keep a `ROLLBACK;` path.
- `SELECT … FOR UPDATE` locks the selected rows; `FOR UPDATE SKIP LOCKED` is the correct
  pattern for a worker queue.
- `TRUNCATE` takes an ACCESS EXCLUSIVE lock and is transactional here (unlike MySQL), so
  it can be rolled back — but it still blocks readers.
- Creating an index takes a SHARE lock unless you use `CREATE INDEX CONCURRENTLY`, which
  cannot run inside a transaction block.
- A statement that fails aborts the whole transaction: every later statement returns
  "current transaction is aborted" until you `ROLLBACK`.

## Reading a plan

`EXPLAIN` shows the estimator's plan; `EXPLAIN (ANALYZE, BUFFERS)` actually runs it.
`ANALYZE` executes the statement — never use it on a write without a transaction you
intend to roll back. The operators that signal a problem: `Seq Scan` on a large table
filtered by a selective predicate, `Nested Loop` over a large outer set, and a large
difference between estimated and actual rows (stale statistics — consider `ANALYZE`).

## See also

- `query-performance-tuning` — sargability and index reasoning that apply across engines.
- `tsql-safety-guardrails` — the mutation discipline (engine-independent).
