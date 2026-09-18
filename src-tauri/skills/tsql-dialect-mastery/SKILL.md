---
name: tsql-dialect-mastery
description: This skill should be used when the user asks to "write T-SQL", "convert this query to SQL Server", "why does TOP or LIMIT not work", or when the target engine is Microsoft SQL Server.
version: 1.0.0
license: MIT
---

# T-SQL Dialect Mastery

Load this before writing or rewriting any statement for a Microsoft SQL Server
connection. The goal is that generated T-SQL is _valid on the first try_ and does
not silently change semantics when it arrives from another dialect.

## Workflow

1. Confirm the engine is SQL Server (the run preamble states the engine; `describe_table`
   confirms types). If the workspace is bound to another engine, load that engine's
   skill instead and stop.
2. Check the target tables with `describe_table` before writing SQL that depends on
   column names, types, or nullability. Never guess a column name.
3. Write the statement using the mappings below. Prefer `run_readonly_sql` for reads
   and `preview_write` for anything that mutates.
4. Run `check_sql` before executing a non-trivial statement. It catches the dialect
   mistakes this skill lists.
5. For `SELECT` work, add an explicit `TOP`/`OFFSET` bound unless the user asked for a
   full extract.

## Pagination: the #1 translation failure

| Other dialect        | T-SQL                                               |
| -------------------- | --------------------------------------------------- |
| `LIMIT 10`           | `SELECT TOP (10) …`                                 |
| `LIMIT 10 OFFSET 20` | `ORDER BY … OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY` |
| `SELECT … LIMIT 1`   | `SELECT TOP (1) …`                                  |

`OFFSET … FETCH` **requires** an `ORDER BY`. Without it SQL Server raises an error,
so always add a deterministic `ORDER BY` (include a key column as the tiebreaker).

## Identifier quoting

Use square brackets: `[dbo].[Orders]`. Double quotes work only when
`QUOTED_IDENTIFIER` is `ON`, which is not guaranteed in every session — brackets
always work. Never emit backticks.

## Null semantics

- `ISNULL(a, b)` — T-SQL only, exactly two arguments, result type follows the **first**
  argument.
- `COALESCE(a, b, …)` — ANSI, variadic, result type is the highest-precedence argument.
  Use `COALESCE` when portability or >2 arguments matters.
- `+` with a `NULL` operand yields `NULL`. Concatenate with `CONCAT(a, b)` or
  `CONCAT_WS('-', a, b)` which treat `NULL` as an empty string.
- `a <> b` is `UNKNOWN` when either side is `NULL`. Use
  `(a <> b OR (a IS NULL) <> (b IS NULL))` or `EXISTS` rather than `NOT IN` — `NOT IN`
  over a set containing `NULL` returns no rows at all.

## Type conversions

- `CONVERT(varchar(10), d, 120)` for explicit date formatting;
  `FORMAT(d, 'yyyy-MM-dd')` is convenient but slow — avoid it inside a `WHERE`.
- `TRY_CONVERT` / `TRY_CAST` return `NULL` instead of raising. Use them when parsing
  user-supplied text.
- Implicit conversion is the classic silent plan killer: comparing an `int` column to a
  string literal, or a `varchar` column to an `nvarchar` parameter, forces a scan.
  Match the literal to the column type and prefix national literals with `N''`.

## Dates and times

- Prefer `datetime2` over `datetime` (wider range, no 3.33 ms rounding).
- `DATEADD(day, -30, SYSUTCDATETIME())` for relative windows;
  `DATEDIFF(day, start, end)` for whole-unit differences.
- `GETDATE()` is server-local; `SYSUTCDATETIME()` is UTC. State which one is intended
  when the result is user-visible.

## Generated keys and identity

| Function             | Scope                                                  |
| -------------------- | ------------------------------------------------------ |
| `SCOPE_IDENTITY()`   | Current scope — **use this one**                       |
| `@@IDENTITY`         | Session-wide, jumps across triggers — do not use       |
| `IDENT_CURRENT('t')` | Any session — do not use for "the row I just inserted" |

Prefer the `OUTPUT INSERTED.id` clause: it is trigger-safe and returns set semantics in
one round trip.

## Set operations, joins, and aggregates

- `CROSS APPLY` / `OUTER APPLY` are the T-SQL equivalents of lateral joins; use them
  instead of correlated subqueries in `SELECT` when returning multiple columns.
- `STRING_AGG(col, ', ')` replaces `GROUP_CONCAT` / `string_agg` ordering arguments
  differ — put `WITHIN GROUP (ORDER BY …)` after the separator.
- `EXISTS (SELECT 1 FROM …)` is preferred over `IN (SELECT …)` — it is NULL-safe and
  usually plans better.
- `MERGE` is error-prone (it has documented correctness bugs around duplicate source
  rows and concurrent updates). Prefer an explicit `UPDATE` + `INSERT` pair inside a
  transaction unless the user explicitly asks for `MERGE`.

## Batch and session control

- `GO` is a **client-side batch separator**, not T-SQL. Never send it through the
  driver; split into separate statements instead.
- `SET NOCOUNT ON` at the top of a script prevents spurious row-count results.
- `#temp` tables are real tables (statistics, indexes, usable in plans); table
  variables are not. Use `#temp` when the row count is not tiny.
- CTEs are not reused in T-SQL: each reference re-executes the CTE. Materialize into a
  `#temp` table when a CTE is referenced more than once in a large query.

## Error handling

`TRY…CATCH` catches at the statement level; `ERROR_MESSAGE()` / `ERROR_NUMBER()` /
`ERROR_LINE()` are only valid inside a `CATCH` block. Wrap multi-statement writes in
`BEGIN TRY / BEGIN TRAN … COMMIT / BEGIN CATCH … ROLLBACK` and re-raise with
`THROW;` (re-raising preserves the original error, unlike `RAISERROR`).

## Additional Resources

- `references/keyword-map.md` — full ANSI ↔ T-SQL translation table, including
  functions, aggregates, and string/date built-ins.
- `references/gotchas.md` — the subtle correctness traps (NULL arithmetic, trailing
  spaces in comparisons, `COUNT(*)` vs `COUNT(col)`, `TOP` with ties, collation).

Read these with `read_skill_resource` when a mapping is not covered above.
