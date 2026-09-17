---
name: data-profiling
description: This skill should be used when the user asks to "profile a table", "check data quality", "find duplicates or nulls", "how many rows are null", or asks for the shape and health of a dataset.
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
    find_value,
    skill,
    read_skill_resource,
    read_memory,
    save_memory,
    remember_term,
    create_checkpoint,
    finish,
  ]
---

# Data Profiling

Produce a factual health report for a table without ever modifying it. This skill is
read-only by contract: its `allowed-tools` list excludes `preview_write`, so a
profiling run cannot mutate data.

## Workflow

1. `describe_table` the target. Never profile a table whose columns you are guessing.
2. Get the row count from `sys.dm_db_partition_stats` — **not** `COUNT(*)`. On a large
   table `COUNT(*)` is a full scan and can take minutes. `scripts/profile-table.sql`
   query 1 gives the estimate and the row count in one pass.
3. Run the checks below, in order, and keep every number you observe. A profile is
   evidence, not narrative.
4. Report findings ranked by impact, each with the query that produced it. Do not
   state a finding you did not compute.

## Checks

| Check                    | Why it matters                                                           | Method                                                |
| ------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| Row count                | Baseline for every other ratio                                           | `sys.dm_db_partition_stats`                           |
| Per-column NULL %        | Findable only here; drives `IS NULL` predicates and `NOT NULL` decisions | `COUNT(*) - COUNT(col)` (see dialect gotcha #2)       |
| Distinct cardinality     | A column with 1 distinct value over 1M rows is a constant, not a filter  | `COUNT(DISTINCT col)` on the low-cost columns only    |
| Duplicate keys           | Breaks `UPDATE … FROM JOIN`, `MERGE`, and any "one row per" assumption   | `GROUP BY key HAVING COUNT(*) > 1`                    |
| Orphan foreign keys      | Referential integrity that has been bypassed or disabled                 | `LEFT JOIN` child → parent `WHERE parent.key IS NULL` |
| Min/max/range            | Detects placeholder values (`1900-01-01`, `-1`, `''`) and outliers       | `MIN`/`MAX` on ordered types                          |
| All-identical column     | Almost always a modelling error                                          | `MIN(col) = MAX(col)`                                 |
| Empty string vs NULL mix | Two "missing" encodings in one column breaks filters                     | `COUNT(*) WHERE col = ''` vs `IS NULL`                |
| Status/enum distribution | Confirms the domain of a low-cardinality column                          | `GROUP BY col ORDER BY COUNT(*) DESC`                 |

## Cost control

- Bound every exploratory query. `SELECT TOP (1000)` for samples; never `SELECT *` on a
  large table just to look at it.
- Compute the cheap counts first (`COUNT`, `MIN`, `MAX`) and the expensive ones
  (`COUNT(DISTINCT)`) only for columns that the request actually cares about.
- On a very large table, run checks on a sample (`TABLESAMPLE SYSTEM (1 PERCENT)`) and
  say explicitly that the numbers are sampled estimates.
- Group independent aggregates into a single `SELECT` per table so the table is scanned
  once rather than once per check.

## Reporting format

Return a compact table plus a short list of findings:

```
Table: sales.Orders            rows: 4,182,330 (estimate)

column        type           null %   distinct   notes
------------  -------------  -------  ---------  ----------------------------------
order_id      bigint (PK)      0.00   4,182,330  unique, no gaps assumed
customer_id   int             0.00     118,204   FK → crm.Customer(customer_id)
deleted_at    datetime2     100.00           0   never written — soft-delete is unused
status        varchar(20)     0.00           4   'new','paid','shipped','cancelled'
amount_cents  int             0.00     902,118   min 1, max 9,999,900

Findings
1. `deleted_at` is NULL for every row (query: ...). Any `WHERE deleted_at IS NULL`
   predicate is a no-op and should be dropped from hot queries.
2. 12 orphan `customer_id` values have no parent row (query: ...). Either a FK is
   disabled or the child rows predate it.
```

## Persisting what you learned

Profiling produces durable facts about a specific connection/database — exactly what
agent memory is for. After a profile run, `save_memory` the findings that would change
future decisions, for example: which column encodes "deleted", which amount columns are
stored in minor units, which tables are huge and must never be counted with `COUNT(*)`,
and which enum values are live. Use `remember_term` for business vocabulary the user
teaches during the run ("'active customer' = last_login_at within 90 days").

## See also

- `scripts/profile-table.sql` — ready-to-run profiling queries, including the
  single-pass aggregate and the duplicate/orphan checks.
- The `schema-documentation` skill when the goal is documentation rather than health.
- The `tsql-dialect-mastery` skill for the NULL and integer-division traps that make
  profiling numbers wrong.
