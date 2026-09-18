---
name: safe-update
description: Build the SELECT preview for an intended UPDATE or DELETE, prove the row count, then stage it for approval.
argument-hint: "[what to change]"
allowed-tools: read_memory, describe_table, check_sql, preview_write, sample_table_data
inject: bound_connection, current_database, active_tab_sql
---

# Safe update

Change data without ever running a write the user has not seen. The order below
is the contract: preview, prove, then stage for approval.

## Intent

```
$ARGUMENTS
```

## Method

**Phase 1 — load the guardrail skill.** Load `tsql-safety-guardrails` before
writing anything. It wins over your own habits when the two disagree.

**Phase 2 — build the predicate in a `SELECT` first.** Write the intended
`WHERE` clause as a `SELECT` that returns the primary key of every affected row.
Run it. A predicate you have not run is a predicate you do not know.

**Phase 3 — prove the blast radius.** Report:

- the exact rows affected (count, not an estimate),
- a sample of them,
- what you expected and why, if the two differ.

If the count is larger than the user's request implies, **stop** and say so. Do
not proceed because the statement is syntactically valid — an `UPDATE` that hits
the whole table is syntactically valid.

**Phase 4 — stage, do not execute.** Call `preview_write` with the final
statement — with its `WHERE` clause attached — so the user approves the exact
text that will run. Never assemble the write in a way that could drop the
`WHERE` between the preview and the execution.

**Phase 5 — wrap when it is more than one statement.** Multi-statement writes go
inside an explicit transaction with the keys read inside it. Say what the
rollback is before you ask for approval.

**Phase 6 — confirm the result.** After approval and execution, run the verifying
`SELECT` again and state whether the new state matches the intent. Reporting
"executed successfully" without re-reading the data is not verification.
