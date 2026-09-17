---
name: schema-documentation
description: This skill should be used when the user asks to "document the schema", "generate a data dictionary", "describe all tables", or "explain the ER model".
version: 1.0.0
license: MIT
---

# Schema Documentation

Turn the live catalog into a written artifact: a data dictionary, an ER description, or
an onboarding summary of a database you have never seen. Source of truth is always the
catalog (`sys.*` on SQL Server, `information_schema`, or the engine equivalent) — never
guess a column type or a relationship from a table name.

## What a useful data dictionary contains

For each table: purpose (one line), row count, primary key, unique keys, foreign keys
with their targets, and each column's type/nullability/default plus a description when
the name is not self-explanatory. For each relationship: cardinality and whether it is
enforced.

Ordering matters for readability: core/entity tables first, then join tables, then
lookup/reference tables, then audit/log tables.

## Catalog queries (T-SQL)

```sql
-- Tables with row counts (approximate, cheap — from the partition stats DMV)
SELECT s.name AS schema_name, t.name AS table_name, SUM(p.row_count) AS row_count
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
GROUP BY s.name, t.name
ORDER BY row_count DESC;

-- Columns
SELECT c.table_name, c.column_name, c.data_type, c.max_length, c.is_nullable,
       c.column_default, c.ordinal_position
FROM information_schema.columns c
WHERE c.table_schema NOT IN (N'sys', N'INFORMATION_SCHEMA')
ORDER BY c.table_name, c.ordinal_position;

-- Foreign keys with targets
SELECT fk.name AS fk_name,
       OBJECT_SCHEMA_NAME(fk.parent_object_id) AS from_schema,
       OBJECT_NAME(fk.parent_object_id) AS from_table,
       COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS from_column,
       OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS to_schema,
       OBJECT_NAME(fk.referenced_object_id) AS to_table,
       COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS to_column
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
ORDER BY from_table, fk_name;
```

`scripts/` in the `tsql-dialect-mastery` skill holds the extended catalog query set —
read it with `read_skill_resource` instead of rewriting these from memory.

## Deriving a relationship that is not enforced

Many real databases have joins that no foreign key enforces. Infer them, but **label the
inference**: a candidate relationship is a claim that must be verified by a query, not a
fact to be stated.

To propose a candidate: a column named `<entity>_id` that shares a name with another
table's primary key (or `<table>_id` matching `<table>`), plus a query proving the join
resolves:

```sql
SELECT COUNT(*) AS total,
       COUNT(t.customer_id) AS matched
FROM dbo.orders t
LEFT JOIN dbo.customer c ON c.id = t.customer_id;
```

`matched < total` means the relationship is **not** enforced — report it as a data-quality
finding, because it usually is one.

## Working with an unfamiliar database

Do this in order, and stop when the user's question is answered — a full dictionary is
expensive on a large schema:

1. `list_tables` — get the shape and the sizes.
2. Identify the **core entities** (the ones most other tables point at) and the
   **fact tables** (highest row counts with `*_id` columns and dates).
3. `describe_tables` on the core set only.
4. Map relationships from `sys.foreign_keys`, then note the unenforced joins.
5. Summarize in prose first (what this database is _about_), then the per-table detail.

## Output format

Lead with a short prose summary — what the database records and its main entities — then
the tables. Use a markdown table per entity group rather than one enormous table. Mark
every inferred relationship as inferred, and every approximate number as approximate
(`row_count` from partition stats is maintained by the engine, not scanned).

## See also

- `tsql-dialect-mastery` — `sys.*` catalog view semantics and dialect details.
- `data-profiling` — when the documentation needs actual data characteristics, not just
  structure.
