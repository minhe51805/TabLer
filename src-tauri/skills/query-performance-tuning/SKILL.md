---
name: query-performance-tuning
description: This skill should be used when the user asks "why is this query slow", "help me optimize this", "add an index", "it takes too long", or when a query is known to scan a large table.
version: 1.0.0
license: MIT
allowed-tools:
  [
    list_tables,
    describe_table,
    describe_tables,
    sample_table_data,
    run_readonly_sql,
    check_sql,
    skill,
    read_skill_resource,
    read_memory,
    save_memory,
    remember_term,
    finish,
  ]
---

# Query Performance Tuning

Diagnose slowness from **evidence**, never from intuition. Every claim in the answer
must be backed by a query that ran: a plan, a statistics reading, or a row count.
"Probably missing an index" is not a finding.

## Workflow

1. Get the SQL text under discussion (the active tab, or the user's message).
2. Establish the table's size first (`sys.dm_db_partition_stats`) — an index does not
   matter on 200 rows, and a scan is fatal on 200M.
3. Inspect the existing index inventory (`scripts/` in the `tsql-dialect-mastery` skill,
   query 5–6). Never propose an index that already exists.
4. Identify the anti-pattern from the checklist below, or read the plan.
5. Propose the smallest change that addresses the evidence, with the expected effect and
   the cost. Then give the verification query the user can run to confirm.

## Anti-pattern checklist (check these before anything else)

| Anti-pattern                                                                                | Why it hurts                                        | Fix                                                                                        |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Function on a column in `WHERE`: `WHERE YEAR(d) = 2024`, `WHERE CAST(id AS varchar) = '42'` | Prevents the seek; forces a full scan               | Rewrite to a range: `d >= '2024-01-01' AND d < '2025-01-01'`; compare on the matching type |
| Implicit conversion: `int_col = '42'`, `varchar_col = N'x'`                                 | Same — scan, plus possible runtime error            | Match literal type to column type                                                          |
| `LIKE '%term'` (leading wildcard)                                                           | No seek possible; always a scan                     | Full-text index, or reverse-index trick, or accept it and say so                           |
| `SELECT *` on a wide table over many rows                                                   | Reads columns nobody needs; breaks covering indexes | Name the columns                                                                           |
| `OR` across different columns                                                               | Often a scan; hard to index                         | Split into `UNION ALL` of two seeks, or a composite index                                  |
| `NOT IN (subquery)` / `NOT EXISTS` on a big set                                             | Anti-semi-join over the whole set                   | `LEFT JOIN … IS NULL`, or `EXCEPT`                                                         |
| Scalar user-defined function in `SELECT`/`WHERE`                                            | Pre-2019: row-by-row, blocks parallelism            | Inline the expression, or use `WITH SCHEMABINDING` + `INLINE = ON`                         |
| `ORDER BY` on a non-indexed column with a small `TOP`                                       | Sort of the whole set before the limit              | Index the sort keys, or add a tiebreaker and accept the sort                               |
| `OFFSET` pagination deep in a table                                                         | Scans and discards everything before the offset     | Keyset pagination: `WHERE key > @last ORDER BY key`                                        |
| Cursor / `WHILE` row-by-row loop                                                            | Set-based work done one row at a time               | Rewrite as a single set statement                                                          |
| Missing statistics                                                                          | Bad cardinality estimate → bad join order           | `UPDATE STATISTICS` (mention it; do not run it read-only)                                  |

## Index guidance

- **Seek-friendly ordering:** equality predicates first, then the range/`ORDER BY` column,
  then included columns. `(a, b, c)` supports `a`, `a,b`, `a,b,c` — not `b` alone.
- **Covering index:** add the selected columns via `INCLUDE` so the plan stops doing a
  key lookup. A seek + key lookup per row is often slower than a scan.
- **Width costs writes:** every index is paid for on every `INSERT`/`UPDATE`/`DELETE`.
  State the write cost when proposing one.
- **Left-prefix rule:** an index on `(a, b)` cannot seek on `b`. Check the request's
  predicate order against the index definition before proposing a new one.
- **Low-cardinality columns** (a status with 4 values) are poor leading keys; put them
  after the selective column, or filter them out with a filtered index.
- Check `sys.dm_db_missing_index_details` for the server's own suggestions, and
  `sys.dm_db_index_usage_stats` for indexes with zero seeks — a drop candidate.

## Reading an execution plan

Inspect these operators in order of severity: table/index **scan** on a large table
(usually the problem), **sort** with a large estimate, **key lookup** repeated per row,
**hash join** where a nested loop with a seek was possible, **spool** (lazy/eager — a
re-read of the same rows, often from a `MERGE` or a correlated subquery), and any
**estimate vs actual rows** mismatch of >10×, which means stale statistics.

`references/plan-operators.md` explains each operator and what it implies.

## Parameter sniffing

If the query was fast for one input and slow for another, the cached plan was compiled
for an atypical parameter value. Options, cheapest first: update statistics, add
`OPTION (RECOMPILE)` to the one problematic statement, split the query per value range,
or use `OPTIMIZE FOR UNKNOWN`. Do not add `RECOMPILE` globally — it trades a compile
cost on every execution for plan stability.

## Reporting format

Lead with the evidence, not the verdict:

```
Finding: predicate is non-sargable.
Evidence: SELECT ... WHERE CAST(customer_id AS varchar(20)) = '42'
          — sys.dm_db_partition_stats: 4,182,330 rows; index IX_orders_customer_id
          exists on (customer_id) but is not seekable through the cast.
Impact: full index scan of 4.18M rows per execution.
Proposed: compare on the native type — WHERE customer_id = 42.
          Expected: seek on IX_orders_customer_id, ~tens of rows read.
Verify with: SET STATISTICS IO ON; <rewritten query>;  -- expect logical reads to drop
Confidence: 92
```

State a numeric confidence. Only present findings you would score ≥ 80 — anything
lower belongs in a "worth testing" list, not in the recommendation.

## See also

- `references/plan-operators.md` — how to read each operator in a plan.
- The `tsql-dialect-mastery` skill for the conversion and `TOP`/`OFFSET` traps.
- The `tsql-dialect-mastery` skill's `scripts/catalog-queries.sql` (queries 5, 6, 7) for
  index inventory and missing-index suggestions.
