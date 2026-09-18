---
name: profile
description: Profile a table read-only and return a markdown report of its shape, nulls, cardinality and anomalies.
argument-hint: "[table to profile]"
allowed-tools: read_memory, describe_table, sample_table_data, run_readonly_sql, check_sql
inject: bound_connection, current_database, schema_summary
---

# Profile a table

Produce a factual report on the table below. Every number in the report must be
something you measured, never something you estimated.

## Target

```
$ARGUMENTS
```

When `$ARGUMENTS` is empty, profile the selected table that was injected above.

## Method

**Phase 1 — load the skill.** Load `data-profiling`; its `scripts/profile-table.sql`
holds the per-column profile query. Adapt it to the dialect rather than
inventing your own.

**Phase 2 — gather, read-only.** Use `describe_table` for the shape, then run the
profile query with `check_sql` first when the engine needs it. Nothing in this
command writes.

**Phase 3 — report, and mark every claim.**
For each column: type, nullability, distinct count, min/max where meaningful, and
the null percentage. Then flag only what is actually notable:

- a column at 0% null that is nullable (a soft-delete filter that never fires),
- a column at 100% null (dead weight in the row, and in every `SELECT *`),
- a `NOT NULL` column with a single distinct value (a constant pretending to be data),
- a foreign key with orphaned values (a constraint that is not enforced),
- a candidate key that is not declared as one.

**Phase 4 — say what you could not measure.** Row estimates on a large table are
estimates; label them. If a profiling query had to be skipped because it would
scan too much, say so instead of leaving a gap the reader will read as zero.

**Phase 5 — finish with opportunities, each with its evidence.** An index that the
profile justifies, a column that can go, a constraint that should exist. Each
line carries the measurement that motivated it — that is the difference between
a report and an opinion.
