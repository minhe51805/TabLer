---
name: explain
description: Explain a query clause by clause against the real schema, naming the engine semantics that decide the result.
argument-hint: "[query to explain]"
allowed-tools: read_memory, describe_table, run_readonly_sql, sample_table_data
inject: active_tab_sql, bound_connection, selected_table
---

# Explain a query

Explain what this query does to the reader who wrote it — not what the syntax
means in general, but what it will do against **this** schema.

## Query

```sql
$ARGUMENTS
```

When `$ARGUMENTS` is empty, explain the injected active-tab SQL.

## Method

**Phase 1 — ground it in the schema.** Use `describe_table` for every table the
query touches. An explanation that does not name the real column types is a
paraphrase, not an explanation.

**Phase 2 — walk it in execution order**, not in the order it was typed:

1. `FROM` and joins — how many rows each step produces, and why.
2. `WHERE` — which predicates the engine can use as seek predicates and which
   ones it can only filter with. Name the column type when it matters.
3. `GROUP BY` and aggregates — the grain of the result set.
4. `HAVING` versus `WHERE` — say which one you would move and where it belongs.
5. `ORDER BY`, `TOP`, and window functions — what the ordering guarantees.

**Phase 3 — call out what the reader will trip over.** Only when it is real:

- a predicate that silently loses an index (a conversion, a function on a column),
- a join whose `NULL` handling decides whether rows survive,
- a `LEFT JOIN` filtered in `WHERE`, which quietly becomes an inner join,
- a `TOP` without an `ORDER BY`, which has no defined rows.

**Phase 4 — stop at explanation.** Load `tsql-dialect-mastery` when a construct is
engine-specific. Do not propose a rewrite here: `/review-sql` and
`/indexes` cover that, and mixing the two turns an explanation into a critique
the reader did not ask for.
