---
name: duckdb-dialect-mastery
description: This skill should be used when the user asks to "write DuckDB SQL", "query a CSV or Parquet file", "analyze a file with SQL", or when the target engine is DuckDB.
version: 1.0.0
license: MIT
---

# DuckDB Dialect Mastery

Load this when the bound engine is DuckDB. DuckDB is an in-process, column-oriented
analytical engine: the whole database lives in one file, SQL runs through the same
read-only/write tools as every other engine here, and the dialect overlaps PostgreSQL
more than SQLite — but the analytics-first defaults change what "slow" and "correct"
mean.

## Files are first-class tables

You can query files without importing them:

```sql
SELECT * FROM read_csv_auto('sales_2024.csv') LIMIT 10;
SELECT * FROM read_parquet('events/*.parquet') WHERE ts >= '2024-01-01';
```

- `read_csv_auto` sniffs columns, types, and the delimiter. When the sniff is wrong,
  pass the contract explicitly: `read_csv('f.csv', header = true, columns = {'id':
'INTEGER', 'ts': 'TIMESTAMP'})`.
- Globs work: `read_parquet('data/*.parquet')` unions matching files; schema conflicts
  across files are an error — `union_by_name = true` aligns by column name.
- Export is `COPY`: `COPY t TO 'out.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);` and
  `COPY t TO 'out.csv' (HEADER, DELIMITER ',');`. This is the cheapest path for
  "export this query result as Parquet/CSV" requests.
- These are table functions: they can be joined, aggregated, and inserted from like any
  table — `INSERT INTO orders SELECT * FROM read_parquet('new_orders.parquet');`

## Types: real dates, decimals, and nested values

Unlike SQLite, DuckDB has real `DATE`, `TIMESTAMP` (microsecond), `DECIMAL`, and
`HUGEINT` (128-bit). It also has nested types:

- `LIST`: `SELECT [1, 2, 3];` — aggregate into one with `list(col)`, explode with
  `UNNEST(col)` (in the `SELECT` list, it produces one row per element).
- `STRUCT`: `{'a': 1, 'b': 'x'}` — field access is dot notation, `s.a`; `row` casts are
  positional.
- `MAP` exists too; prefer `STRUCT` for fixed shapes and `MAP` for open key sets.

## Division and numeric quirks

- `/` is **floating-point division even on integers**: `5 / 2` is `2.5`. Integer
  division is `//` (`5 // 2` = `2`). Porting T-SQL/PostgreSQL integer math silently
  changes types here — cast explicitly when the result feeds an integer column.
- Strings are single-quoted, identifiers double-quoted (PostgreSQL rules). `LIKE` is
  case-sensitive; `ILIKE` is the case-insensitive form.

## Modern SQL shortcuts (and their portability cost)

- `GROUP BY ALL` — groups by every non-aggregated `SELECT` column. Concise, and the
  single most-asked-for port when moving queries to other engines: it does not exist in
  PostgreSQL or SQL Server. Offer the explicit `GROUP BY` list when the user needs a
  portable statement.
- `SELECT * EXCLUDE (col1, col2)` and `SELECT * REPLACE (upper(name) AS name)` —
  projection filters; same portability caveat.
- `QUALIFY` — filters window-function output without a subquery:
  `SELECT * FROM t QUALIFY row_number() OVER (PARTITION BY g ORDER BY ts DESC) = 1`.
  The portable spelling is the subquery form; say which you produced.

## Upsert

```sql
INSERT INTO customer (id, email) VALUES (1, 'a@b.c')
ON CONFLICT (id) DO UPDATE SET email = excluded.email;
INSERT OR REPLACE INTO customer (id, email) VALUES (1, 'a@b.c');
```

- `ON CONFLICT` needs a unique/primary key on the target, like PostgreSQL; `EXCLUDED`
  is the proposed row. `INSERT OR REPLACE` deletes-then-inserts (fires any `ON DELETE`
  behavior, changes `rowid`) — the same trap as SQLite, so prefer `DO UPDATE`.

## Reading other databases

```sql
ATTACH 'archive.db' AS arch;        -- SQLite file
SELECT * FROM arch.main.users;
```

- Attaching SQLite files works out of the box; other engines (PostgreSQL, MySQL) need
  their scanner extension loaded, which a sandboxed build may not have — check before
  promising a cross-engine query, and fall back to "run it there" if the attach fails.

## Plans and sizing

- `EXPLAIN SELECT …` shows the physical plan; `EXPLAIN ANALYZE SELECT …` runs it.
  Operators are uppercase and physical: `SEQ_SCAN` (with the pushed-down filter
  printed), `HASH_JOIN`, `PIECEWISE_MERGE_JOIN`, `HASH_GROUP_BY`, `TOP_N`.
- A `SEQ_SCAN` is not automatically a defect: DuckDB is columnar, so scanning two
  columns of a large table is often cheaper than a random-access index path. Size the
  scan (row count, column width) before calling it the problem — the
  `query-performance-tuning` skill's evidence workflow and the `run_preset`
  `table-stats` preset apply here as anywhere.
- Sampling for profiling: `USING SAMPLE 1%` (or `USING SAMPLE 10000 ROWS`) keeps
  exploratory queries fast on big tables; `data-profiling`'s queries can be sampled
  this way without changing their conclusions' direction.

## Process model caveats

- One writer at a time per database file (single-process embedded engine). Long
  analytical queries hold their memory budget; `PRAGMA memory_limit = '4GB'` (default
  ~80% of RAM) bounds them — when a query dies on memory, say so and suggest the limit
  or a smaller scan rather than retrying blind.
- No stored procedures, no server-side users, no `GRANT`. There is no `LIMIT`-less
  default result cap — an unbounded `SELECT *` on a wide Parquet set is a real memory
  risk, so always pair exploration with `LIMIT` or `USING SAMPLE`.

## See also

- `query-performance-tuning` — the evidence-first workflow; `references/engine-evidence.md`
  has the DuckDB `EXPLAIN` specifics.
- `data-profiling` — the read-only profiling queries, now samplable with `USING SAMPLE`.
- `postgres-dialect-mastery` — the closest dialect; check it when a PostgreSQL-ism fails.
