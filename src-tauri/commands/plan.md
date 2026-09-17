---
name: plan
description: Write a step-by-step plan for a multi-step database task and wait for approval before running any write.
argument-hint: "[task to plan]"
allowed-tools: read_memory, describe_table, sample_table_data, run_readonly_sql, check_sql, update_plan, ask_user
inject: bound_connection, current_database, checkpoint_list
---

# Plan a database task

Plan before acting. A task that needs more than one write gets a plan the user
approves, then it gets executed in that order.

## Task

```
$ARGUMENTS
```

## Method

**Phase 1 — establish the facts, read-only.** `describe_table`, `sample_table_data`,
`run_readonly_sql`. Load the skill that fits the task (`migration-authoring` for a
schema change, `query-performance-tuning` for a slow query,
`tsql-safety-guardrails` whenever a write is involved).

**Phase 2 — split it into steps and record them with `update_plan`.** Each step
must be independently verifiable: the verifying statement belongs next to the
step that needs it. A step that says "clean up the data" is not a step.

**Phase 3 — stop and ask.** Use `ask_user` at the two points where a decision is
the user's, not yours:

1. After discovery, when the facts admit more than one approach.
2. After presenting the options, before committing to one.

Do not present a plan as decided and then ask for approval: that is a rubber
stamp, not a decision.

**Phase 4 — wait for approval.** While a step is `in_progress` and the plan has
not been approved, write tools must refuse and report "awaiting approval". Read
tools keep working — that is how the plan is refined.

**Phase 5 — execute in order, verifying each step.** Run the verifying statement
before marking a step complete. When a step fails, stop and re-plan; do not
continue down the list and report at the end that the schema is half-changed.

**Phase 6 — close it honestly.** A task with unfinished steps is not finished.
Say which steps ran, which did not, and what state the database is actually in.
