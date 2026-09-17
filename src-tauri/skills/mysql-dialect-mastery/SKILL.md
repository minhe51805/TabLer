---
name: mysql-dialect-mastery
description: This skill should be used when the user asks to "write MySQL SQL", "use ON DUPLICATE KEY", "fix backtick quoting", or when the target engine is MySQL or MariaDB.
version: 1.0.0
license: MIT
---

# MySQL / MariaDB Dialect Mastery

Load this when the bound engine is MySQL or MariaDB (they share most syntax, but note the
differences flagged below).

## Quoting and identifiers

- Identifiers use **backticks**: `` `order` ``, `` `db`.`table` ``. Double quotes are
  strings unless `ANSI_QUOTES` is set, which it usually is not.
- Strings use single quotes with backslash escapes: `'it\'s'` or `'it''s'`.
- `N'...'` introduces a national character string — valid, but unnecessary on modern
  `utf8mb4` columns.

## Upsert

```sql
INSERT INTO customer (id, email, updated_at)
VALUES (1, 'a@b.c', NOW())
ON DUPLICATE KEY UPDATE
    email = VALUES(email),
    updated_at = VALUES(updated_at);
```

- `ON DUPLICATE KEY UPDATE` triggers on **any** unique or primary key conflict, not the
  one you had in mind — check for other unique indexes before relying on it.
- In MySQL 8.0.20+ prefer the aliased form over the deprecated `VALUES()`:
  `INSERT INTO t (...) VALUES (...) AS new ON DUPLICATE KEY UPDATE email = new.email;`
- `REPLACE INTO` **deletes** the conflicting row and inserts a new one. That fires
  `DELETE` triggers and changes the auto-increment value — almost never what you want.
- MySQL has no `RETURNING` (MariaDB does) and no `ON CONFLICT`.

## Types and defaults

| Need                      | MySQL                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Auto-increment            | `AUTO_INCREMENT` column attribute (one per table, must be a key)                                                            |
| Current time              | `NOW()` / `CURRENT_TIMESTAMP`; `NOW(3)` for milliseconds                                                                    |
| Boolean                   | `TINYINT(1)` — there is no native boolean (`TRUE` is an alias for `1`)                                                      |
| `TIMESTAMP` vs `DATETIME` | `TIMESTAMP` is UTC-converted and range-limited to 1970–2038; `DATETIME` stores literally. Pick deliberately                 |
| Implicit default          | `TIMESTAMP` columns may have `DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP` implicitly — check `SHOW CREATE TABLE` |
| Text                      | `VARCHAR(n)` counts **characters** (utf8mb4: up to 4 bytes each) — index prefix limits apply to _bytes_                     |
| Casting                   | `CAST(x AS SIGNED)`, `CAST(x AS CHAR)`, or `CONVERT(x, DATETIME)`                                                           |

## Functions and traps that bite

| Need          | MySQL                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| String concat | `CONCAT(a, b)` — returns NULL if any argument is NULL. **`                                                                                                                                  |     | `is logical OR by default**, not concat, unless`PIPES_AS_CONCAT` is set |
| Coalesce      | `COALESCE`, `IFNULL`, `NULLIF`                                                                                                                                                              |
| Conditional   | `IF(cond, a, b)`, `CASE WHEN … END` (there is no `IIF` before 8.0)                                                                                                                          |
| Limit         | `LIMIT n OFFSET m`; also `LIMIT m, n`. There is no `OFFSET … FETCH`                                                                                                                         |
| `GROUP BY`    | Only-full-group-by is off by default in 5.7+? It is **on** from 5.7 — non-aggregated columns not in `GROUP BY` are rejected (good) but older servers silently return an arbitrary row (bad) |
| Dates         | `DATE_ADD(d, INTERVAL 7 DAY)`, `DATEDIFF(a, b)`, `DATE_FORMAT(d, '%Y-%m')` — no `date_trunc`                                                                                                |
| String agg    | `GROUP_CONCAT(col ORDER BY col SEPARATOR ', ')` — silently truncates at `group_concat_max_len` (1024 by default). Raise it or you get a _quiet_ partial result                              |
| Regex         | `REGEXP`, `REGEXP_REPLACE` (8.0+)                                                                                                                                                           |
| JSON          | `JSON_EXTRACT` / `->` / `->>`; a `JSON` column cannot be indexed directly — add a generated column and index that                                                                           |

## UPDATE/DELETE limits

- `UPDATE t SET …` and `DELETE FROM t` without a `WHERE` touch every row. The client may
  block this (`safe-updates` / `--i-am-a-dummy`) — do not count on it.
- `UPDATE t JOIN u ON …` is MySQL's multi-table form; there is no `UPDATE … FROM`:
  ```sql
  UPDATE orders o JOIN customer c ON c.id = o.customer_id
     SET o.region = c.region
   WHERE c.region IS NOT NULL;
  ```
- `DELETE t FROM t JOIN …` — the target table must be named before `FROM`.
- `TRUNCATE` is DDL here: it **implicitly commits** and cannot be rolled back. Treat it
  as irreversible. `DELETE FROM t` is the transactional alternative.
- DDL in general causes an implicit commit, so "just wrap the migration in a
  transaction" does not work in MySQL.

## Locking and plans

- InnoDB default isolation is `REPEATABLE READ`; a plain `SELECT` is non-locking, but
  `INSERT … SELECT` takes shared locks on the source rows.
- `SELECT … FOR UPDATE` / `LOCK IN SHARE MODE` lock rows; `SKIP LOCKED` exists in 8.0+.
- `EXPLAIN` shows the plan; `EXPLAIN ANALYZE` (8.0.18+) actually executes and reports
  timing (MariaDB uses `ANALYZE FORMAT=JSON`). `EXPLAIN` alone does **not** run the
  statement, unlike PostgreSQL's `ANALYZE`.
- Warning signs in `EXPLAIN`: `type: ALL` (full scan) on a large table, a high `rows`
  estimate with the predicate not in `key`, and `Using filesort` / `Using temporary` on a
  large result.

## See also

- `query-performance-tuning` — sargability, composite index column order, key lookups.
- `tsql-safety-guardrails` — mutation discipline; note the extra MySQL rule that
  `TRUNCATE` is not rollback-safe.
