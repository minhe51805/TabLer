---
name: indexes
description: Propose index candidates with evidence from read-only stats, ranked by the cost each one removes.
argument-hint: "[query or table to index for]"
allowed-tools: read_memory, describe_table, run_readonly_sql, sample_table_data, check_sql
inject: bound_connection, current_database, active_tab_sql
---

# Index candidates

Propose indexes only where you have measured the cost they remove. An index
proposal without a plan behind it is a guess with a maintenance bill attached.

## Target

```sql
$ARGUMENTS
```

When `$ARGUMENTS` is empty, use the injected active-tab SQL.

## Method

**Phase 1 — load the skill.** Load `query-performance-tuning`; it holds the
sargability rules and the expected-plan vocabulary used below.

**Phase 2 — read the plan.** Use `run_readonly_sql`. Record, for every access to a
table, whether it is a seek or a scan, which operator consumed the predicate, and
the estimated rows.

**Phase 3 — find the predicate that cannot be served.** For each scan, find why:
a leading wildcard, a function on the column, a type mismatch forcing a
conversion, a `NOT IN` the optimiser cannot turn into a range. **Where a rewrite
removes the scan, propose the rewrite first** — it is free, and an index is not.

**Phase 4 — propose, with the key order justified.** For each candidate:

- the exact `CREATE INDEX` statement, in the dialect in use,
- why the key columns are in that order (equality first, then range, then the
  included columns that make it covering),
- the measured cost it removes, quoted from the plan,
- the cost it adds: write amplification on every `INSERT`/`UPDATE`/`DELETE`, and
  the storage.

**Phase 5 — rank and stop.** Order the candidates by benefit divided by cost and
present them. Do not run DDL: creating an index is a schema change and needs the
user's decision, not yours.
