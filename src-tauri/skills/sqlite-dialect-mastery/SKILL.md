---
name: sqlite-dialect-mastery
description: This skill should be used when the user asks to "write SQLite SQL", "why does ALTER TABLE fail", "fix a PRAGMA", or when the target engine is SQLite.
version: 1.0.0
license: MIT
---

# SQLite Dialect Mastery

SQLite is a library, not a server: there are no users, no locks you can ask for, and a
much smaller DDL vocabulary. Most "SQL doesn't work" reports on SQLite are one of the four
traps below.

## The four traps

1. **`ALTER TABLE` is minimal.** SQLite supports only `RENAME TO`, `RENAME COLUMN` (3.25+),
   `ADD COLUMN`, and `DROP COLUMN` (3.35+, and only if the column is not indexed, part of
   a key, or referenced elsewhere). Anything else — changing a type, adding a constraint,
   dropping a primary key — must be done by the twelve-step table-rebuild: create a new
   table with the desired shape, copy, drop the old, rename.
2. **Types are suggestions.** Column types are _affinity_, not enforcement: a `VARCHAR(10)`
   column happily stores `'a much longer string'`, and an `INTEGER` column can hold text in
   a weak-typed database. Do not rely on a column type for validation; a `CHECK` constraint
   is the enforcement.
3. **`ADD COLUMN` restrictions.** A new column cannot be `PRIMARY KEY` or `UNIQUE`, cannot
   have a non-constant `DEFAULT` (no `CURRENT_TIMESTAMP` except on `DATETIME`-affinity in
   some versions), and if it is `NOT NULL` it must have a default.
4. **No `RIGHT`/`FULL OUTER JOIN` before 3.39**, no `MERGE`, no stored procedures, no
   `GRANT`, no `FULLTEXT` (FTS is a virtual table). Nothing about a "user" exists.

## Upsert

```sql
INSERT INTO customer (id, email) VALUES (1, 'a@b.c')
ON CONFLICT (id) DO UPDATE SET email = excluded.email;
-- or
INSERT OR REPLACE INTO customer (id, email) VALUES (1, 'a@b.c');
-- or, to ignore silently
INSERT OR IGNORE INTO customer (id, email) VALUES (1, 'a@b.c');
```

`ON CONFLICT (...) DO UPDATE` requires a unique index on the conflict target.
`INSERT OR REPLACE` deletes the existing row and inserts a new one — it fires
`ON DELETE` cascades and resets `rowid`, so prefer `ON CONFLICT DO UPDATE`.

`RETURNING` works from 3.35+ and is the right way to prove a write's effect.

## Identifier and literal rules

- Identifiers may be `"double quoted"`, `` `backticked` `` (MySQL compatibility), or
  `[bracketed]` (SQL Server compatibility). Double quotes are the documented form.
- Single-quoted strings only; escape by doubling (`'it''s'`).
- Because of the compatibility aliases, a _typo_ in an identifier inside double quotes can
  be silently treated as a string literal in some contexts — check column names carefully.

## Dates, and the absence of a date type

SQLite has no date/time type. Dates are integers (Unix epoch), reals (Julian day), or
text (ISO-8601), and the functions operate on those conventions:

```sql
WHERE created_at >= date('now', '-7 days')
SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) FROM orders GROUP BY month;
SELECT datetime('now') AS utc_now;              -- text, UTC
SELECT julianday('now') - julianday(created_at) AS age_days FROM orders;
```

Comparison is **lexicographic** on the stored text, so `'2024-1-5'` does not sort with
`'2024-01-05'`. Always store zero-padded ISO-8601 (`YYYY-MM-DD HH:MM:SS`) and always use
UTC at write time. `date('now','localtime')` is local; use it only when the app expects it.

## Reading rows and plans

- `rowid` is the implicit integer primary key. A table declared `WITHOUT ROWID` has none
  and cannot be manipulated by `rowid`. If a table declares `INTEGER PRIMARY KEY`, that
  column **is** the `rowid` alias.
- `SELECT last_insert_rowid()` returns the last insert on **this connection** — it is
  connection-scoped, not transaction-scoped, and is not safe with concurrent writers to
  the same connection pool.
- `PRAGMA table_info(t)` gives columns; `PRAGMA foreign_key_list(t)` gives FKs;
  `PRAGMA index_list(t)` gives indexes; `PRAGMA integrity_check` validates the file.
- `EXPLAIN QUERY PLAN <stmt>` shows the plan using the values `SCAN` / `SEARCH` /
  `USING INDEX` / `USING TEMP B-TREE`. `SCAN` on a large table with a `WHERE`-able
  predicate means a missing index. `EXPLAIN` alone shows the VDBE bytecode — rarely useful.
- Foreign keys are **off by default**: enforcement requires `PRAGMA foreign_keys = ON`
  per connection. Never assume an FK is enforced.

## Concurrency

- One writer at a time for the whole database file. `PRAGMA journal_mode = WAL` lets
  readers proceed during a write; the default rollback journal blocks.
- Writers get `SQLITE_BUSY` rather than waiting, unless `PRAGMA busy_timeout` is set.
  "Database is locked" is a missing busy-timeout, not corruption.

## See also

- `tsql-safety-guardrails` — mutation discipline, with SQLite's caveat that `TRUNCATE`
  does not exist (`DELETE FROM t` is the equivalent, and it is transactional).
- `migration-authoring` — the rebuild pattern is the SQLite form of an idempotent DDL step.
