# Plan operators — what each one implies

Companion to the `query-performance-tuning` skill. Names below are SQL Server
(`SET STATISTICS PROFILE`, plan output) with the equivalent term from other engines in
parentheses where the wording differs. The question is never "is this operator bad?" but
"what is this operator doing to how many rows?"

## Data access operators

- **Table Scan / Clustered Index Scan** (`Seq Scan` in PostgreSQL, `SCAN t` in SQLite's
  `EXPLAIN QUERY PLAN`, `SEQ_SCAN` in DuckDB). Reads every row. Acceptable on small
  tables or when the query genuinely needs most of the table; fatal when the predicate
  is selective and the table is large. A scan under a selective `WHERE` is the classic
  missing-index or non-sargable-predicate signature.
- **Index Scan** reads the whole index in order. Better than a table scan when the index
  is narrower than the table, still O(all rows). If you expected a seek, something
  blocked it — usually a function on the column, an implicit conversion, or a leading
  wildcard `LIKE`.
- **Index Seek / Clustered Index Seek** (`Index Scan` with a filter in SQLite's output —
  look for `SEARCH … USING INDEX`, `Index Cond` in PostgreSQL). The good case: O(log n)
  to the first matching row plus the matched rows. Check the seek predicate: a seek that
  reads an entire range ("Seek PREDICATE" spanning millions of keys) is a scan wearing a
  seek's clothes.
- **Key Lookup / RID Lookup** (PostgreSQL: the heap fetch under a bitmap or index scan;
  shown as "Heap Fetches" in `EXPLAIN (ANALYZE, BUFFERS)`). For each row the index
  matched, fetch the rest of the row from the table. Fine at tens of rows, per-row
  random I/O at thousands — this is the operator that justifies a covering index
  (`INCLUDE` the selected columns).
- **Bitmap Index Scan / Bitmap Heap Scan** (PostgreSQL). Index matched a range, results
  bitmap-anded/or-ed, then heap fetched in physical order. Usually reasonable; a huge
  bitmap on low-selectivity predicates is a scan in disguise.

## Join operators

- **Nested Loops** (PostgreSQL `Nested Loop`, MySQL looks like this when driven by an
  index on the inner side, DuckDB `PIECEWISE_MERGE_JOIN`/index join variants). Right
  choice when the outer side is small and the inner side has a supporting index — the
  plan must show a seek on the inner. Nested Loops over a large outer set with a scan
  inner is the worst shape in any engine: O(outer × inner).
- **Hash Match (join)** (`HASH_JOIN` in DuckDB, hash join in PostgreSQL/MySQL). Builds a
  hash table on the smaller input, probes with the larger. Good for large
  unsorted inputs. "Build" side spills to tempdb/disk when the estimate is wrong —
  memory grants matter. A hash join on an equality where a seek was possible usually
  means statistics or selectivity misled the optimizer.
- **Merge Join** (`MERGE_JOIN`, PostgreSQL `Merge Join`). Sorted inputs merged in one
  pass. Efficient at scale but demands sort order — check for a hidden `Sort` feeding
  it, which means the sort cost was just moved, not removed.

## Blocking / row-shuffling operators

- **Sort** (`SORT`). Blocks until all input is read. Watch for: sort of millions of rows
  under a `TOP (n)` that an index could have avoided, and sorts spilled to disk
  (SQL Server: tempdb spills shown in the plan warning; PostgreSQL: `external merge`
  in `EXPLAIN ANALYZE`).
- **Spool (lazy/eager, Table Spool, Index Spool)**. Materializes intermediate rows to
  re-read them — almost always appears above a `MERGE` statement or a correlated
  subquery re-evaluated per row. Rewriting the statement set-based usually removes it.
- **Stream Aggregate / Hash Aggregate** (`HASH_GROUP_BY`, PostgreSQL `HashAggregate` /
  `GroupAggregate`). Stream needs sorted input (often free if fed by an index);
  hash handles unsorted input but needs memory. A `Sort → Stream Aggregate` pair for a
  plain `COUNT` is the optimizer telling you no index provides the order.
- **Parallelism / Gather Streams** (`Gather` in PostgreSQL plans). Rows are collected
  from parallel branches. Fine at scale; parallelism for a query touching a few hundred
  rows means the cost estimate blew up.

## Estimate vs actual

The single most diagnostic number in any plan: **estimated rows vs actual rows**.
A mismatch above roughly one order of magnitude means the optimizer chose a plan for a
fiction — stale statistics, a parameter sniffed at an atypical value, or a predicate the
statistics cannot represent (local variables, cross-table correlation). Fix the
statistics or rewrite the predicate before touching indexes: an index added to serve a
miscalibrated estimate is usually the wrong index.

## Reading order

1. Find the largest actual-row operator (or total subtree cost, when only estimated plans
   are available).
2. Walk from it upward: is data being filtered late that could have been filtered early?
3. Check its children: scans where seeks were possible, lookups repeated per row, sorts
   feeding aggregates, spills under memory-heavy operators.
4. Compare estimates to actuals at the point of divergence, not at the root — the first
   lying estimate is the cause; everything above it is consequences.
