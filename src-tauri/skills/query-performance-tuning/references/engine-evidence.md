# Evidence per engine — the sanctioned paths

Companion to the `query-performance-tuning` skill. The workflow ("size first, then index
inventory, then anti-pattern check") is engine-independent, but **how** you gather
evidence is not. This file is the per-engine map.

## The rule that comes first

Server-state inspection goes through **`run_preset`**, not raw catalog SQL. The tool's
own contract states that preset queries are the only sanctioned way to inspect server
state and that catalog queries (the `pg_stat_*` family, SQL Server's `sys.dm_*`
dynamic-management views, `performance_schema`) are blocked in `run_readonly_sql` on
purpose. A reference that told you to "just query `pg_stat_user_indexes`" would be
teaching a path the tool refuses to honor — treat the preset as the route and treat a
preset error as the signal to fall back, never to catalog SQL.

Preset ids: `table-stats` (per-table size and row counts), `index-usage` (unused or
rarely-used indexes), `slow-queries` (heaviest / longest-running statements), `locks`
(lock and contention state), `process-list` (running queries and sessions), `server-info`
(engine build and uptime), `user-management`, `kill-session`.

Availability is per engine: a preset the bound engine does not support returns an error
with a reason. On such an engine, fall back to the statements below — never fall back to
catalog SQL.

## The workflow, mapped to tools

1. **Size the table** → `run_preset` with `table-stats`. An index does not matter on
   200 rows; a scan is fatal on 200M.
2. **Index inventory** → `run_preset` with `index-usage`. Never propose an index that
   already exists, and treat an index with zero or near-zero usage as a drop candidate
   (its write cost is paid on every mutation).
3. **Evidence for the specific statement** → `EXPLAIN` per engine (below), plus the
   anti-pattern checklist in the main skill.
4. **History when available** → `run_preset` with `slow-queries` and `locks` to connect
   the statement to observed contention or wall-clock cost.

## `EXPLAIN` per engine

All of these are plain statements and run through `run_readonly_sql`:

- **PostgreSQL** — `EXPLAIN SELECT …` shows the plan with row estimates;
  `EXPLAIN (ANALYZE, BUFFERS) SELECT …` executes it and reports actual rows and I/O.
  `ANALYZE` really runs the statement — on a write, wrap it in a transaction you roll
  back. Operator names: `Seq Scan`, `Index Scan`, `Bitmap Heap Scan`, `Nested Loop`,
  `Hash Join`, `Sort` (with `external merge` meaning a disk spill).
- **MySQL / MariaDB** — `EXPLAIN FORMAT=TRADITIONAL SELECT …`; `EXPLAIN ANALYZE SELECT …`
  (8.0.18+) executes and times every iterator. Read `type` first: `ALL` is a full scan,
  `index` scans the whole index, `range`/`ref`/`eq_ref` are progressively better;
  `Using filesort` and `Using temporary` in `Extra` are the two costs people miss.
- **SQLite** — `EXPLAIN QUERY PLAN SELECT …`. Look for `SCAN` (bad on selective
  predicates) versus `SEARCH … USING INDEX` (good), and `USING TEMP B-TREE` for
  sorts/dedup that an index could remove. Plain `EXPLAIN` dumps VDBE bytecode — not
  useful here.
- **DuckDB** — `EXPLAIN SELECT …` and `EXPLAIN ANALYZE SELECT …`. Operators are physical
  and uppercase: `SEQ_SCAN`, `SEQ_SCAN` with a filter pushdown note, `HASH_JOIN`,
  `PIECEWISE_MERGE_JOIN`, `HASH_GROUP_BY`, `TOP_N`. DuckDB is columnar and in-process:
  a full scan of a narrow column set is often cheaper than an index would be, so treat
  `SEQ_SCAN` as a finding to size (via `table-stats`) rather than an automatic defect.
- **SQL Server** — plan text is not retrievable through `run_readonly_sql`. Evidence
  comes from row counts (`table-stats`), the index inventory (`index-usage`), the
  anti-pattern checklist, and — where the driver accepts it — `SET STATISTICS IO ON`
  before the statement so the logical-read counts come back with the result set.
  State explicitly in the answer which evidence you could and could not gather.

## What a finding must cite

Every performance answer cites statements that actually ran: the preset id and its
numbers, or the `EXPLAIN` output, or a row count. "Probably missing an index" without one
of those is not a finding. This mirrors the main skill's confidence rule: only present
recommendations you would score ≥ 80, and name the verification query the user can run.
