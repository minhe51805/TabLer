---
name: review-sql
description: Review the current SQL against the guardrail and performance skills, returning only confidence-scored findings of 80 or above.
argument-hint: "[sql or table to review]"
allowed-tools: read_memory, describe_table, sample_table_data, run_readonly_sql, check_sql
inject: active_tab_sql, schema_summary, bound_connection
---

# Review SQL

Review the SQL below as a senior T-SQL reviewer. Findings are ranked, and only
findings you can defend with evidence are reported.

## Target

```sql
$ARGUMENTS
```

When `$ARGUMENTS` is empty, review the active tab SQL that was injected above.

## Skills to load first

1. `tsql-safety-guardrails` — for the destructive-statement questions.
2. `query-performance-tuning` — for the scan/seek and sargability questions.
3. `tsql-dialect-mastery` — when a construct is engine-specific.

## Method

**Phase 1 — read before judging.** Use `describe_table` for every referenced
table and `run_readonly_sql` before claiming anything about performance. A review
that guesses at the plan is a review that is wrong half the time.

**Phase 2 — score each finding.** Assign a confidence from 0 to 100:

- **90–100** — the plan or the schema proves it (a scan you actually observed).
- **80–89** — a schema fact plus a well-known engine rule makes it certain
  (implicit conversion on a non-sargable predicate against a typed column).
- **Below 80** — do not report it. Say what you would need to look at instead.

**Phase 3 — report, strictest first.** For each finding at 80 or above:

- the clause and the exact text at fault,
- what the engine does today, with the evidence you gathered,
- the rewritten SQL that fixes it,
- the risk of the rewrite (a plan change can help one query and hurt another).

**Phase 4 — do not change anything.** This command reviews. If the SQL needs a
fix applied, say so and offer `/safe-update` instead of running a write.
