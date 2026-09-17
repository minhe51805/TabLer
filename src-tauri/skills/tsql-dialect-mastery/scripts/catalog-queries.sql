-- SQL Server introspection queries (read-only) for schema discovery, index inventory,
-- foreign-key mapping, and size estimation. All are safe to run with run_readonly_sql.
-- Placeholders use {schema}/{table} style comments — substitute literal identifiers
-- (they are not bindable parameters; validate them against describe_table output first).

-- 1. Tables with row-count and space estimates (never COUNT(*) a large table).
SELECT s.name AS schema_name,
       t.name AS table_name,
       SUM(CASE WHEN p.index_id IN (0, 1) THEN p.row_count ELSE 0 END) AS row_count,
       CAST(SUM(p.used_page_count) * 8.0 / 1024 AS decimal(18, 2)) AS used_mb
FROM sys.dm_db_partition_stats AS p
JOIN sys.tables AS t ON t.object_id = p.object_id
JOIN sys.schemas AS s ON s.schema_id = t.schema_id
GROUP BY s.name, t.name
ORDER BY row_count DESC;

-- 2. Column inventory for one table, with nullability and type.
SELECT c.column_id,
       c.name AS column_name,
       ty.name AS type_name,
       c.max_length,
       c.precision,
       c.scale,
       c.is_nullable,
       c.is_identity,
       dc.definition AS default_definition
FROM sys.columns AS c
JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.default_constraints AS dc ON dc.parent_object_id = c.object_id
                                       AND dc.parent_column_id = c.column_id
WHERE c.object_id = OBJECT_ID(QUOTENAME('{schema}') + '.' + QUOTENAME('{table}'))
ORDER BY c.column_id;

-- 3. Primary keys and unique constraints.
SELECT kc.name AS constraint_name,
       kc.type_desc AS constraint_type,
       col.name AS column_name,
       ic.key_ordinal
FROM sys.key_constraints AS kc
JOIN sys.index_columns AS ic ON ic.object_id = kc.parent_object_id
                            AND ic.index_id = kc.unique_index_id
JOIN sys.columns AS col ON col.object_id = ic.object_id
                       AND col.column_id = ic.column_id
WHERE kc.parent_object_id = OBJECT_ID(QUOTENAME('{schema}') + '.' + QUOTENAME('{table}'))
ORDER BY kc.name, ic.key_ordinal;

-- 4. Foreign keys (outbound) with the referenced target.
SELECT fk.name AS fk_name,
       OBJECT_SCHEMA_NAME(fk.parent_object_id) AS child_schema,
       OBJECT_NAME(fk.parent_object_id) AS child_table,
       COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS child_column,
       OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS parent_schema,
       OBJECT_NAME(fk.referenced_object_id) AS parent_table,
       COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS parent_column
FROM sys.foreign_keys AS fk
JOIN sys.foreign_key_columns AS fkc ON fkc.constraint_object_id = fk.object_id
ORDER BY child_schema, child_table, fk_name;

-- 5. Index inventory with usage stats — find unused and missing indexes.
SELECT OBJECT_SCHEMA_NAME(i.object_id) AS schema_name,
       OBJECT_NAME(i.object_id) AS table_name,
       i.name AS index_name,
       i.type_desc,
       i.is_unique,
       i.is_primary_key,
       ISNULL(us.user_seeks, 0) AS user_seeks,
       ISNULL(us.user_scans, 0) AS user_scans,
       ISNULL(us.user_lookups, 0) AS user_lookups,
       ISNULL(us.user_updates, 0) AS user_updates
FROM sys.indexes AS i
LEFT JOIN sys.dm_db_index_usage_stats AS us
       ON us.object_id = i.object_id AND us.index_id = i.index_id
      AND us.database_id = DB_ID()
WHERE i.object_id = OBJECT_ID(QUOTENAME('{schema}') + '.' + QUOTENAME('{table}'))
  AND i.type > 0
ORDER BY user_seeks + user_scans + user_lookups ASC, i.name;

-- 6. Index key and included columns.
SELECT i.name AS index_name,
       i.type_desc,
       col.name AS column_name,
       ic.key_ordinal,
       ic.is_included_column,
       ic.is_descending_key
FROM sys.indexes AS i
JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns AS col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
WHERE i.object_id = OBJECT_ID(QUOTENAME('{schema}') + '.' + QUOTENAME('{table}'))
  AND i.type > 0
ORDER BY i.name, ic.is_included_column, ic.key_ordinal;

-- 7. Live missing-index suggestions (server has been running long enough to advise).
SELECT migs.avg_total_user_cost AS avg_cost,
       migs.avg_user_impact AS avg_impact_pct,
       migs.user_seeks,
       migs.user_scans,
       mid.statement AS object_name,
       mid.equality_columns,
       mid.inequality_columns,
       mid.included_columns
FROM sys.dm_db_missing_index_group_stats AS migs
JOIN sys.dm_db_missing_index_groups AS mig ON mig.index_group_handle = migs.group_handle
JOIN sys.dm_db_missing_index_details AS mid ON mid.index_handle = mig.index_handle
WHERE mid.database_id = DB_ID()
ORDER BY migs.avg_user_impact * migs.user_seeks DESC;

-- 8. Uniqueness check before an UPDATE … FROM JOIN (gotcha #10).
-- Returns duplicate keys when the join is one-to-many; expect zero rows.
SELECT k.join_key, COUNT(*) AS matches
FROM (SELECT join_key FROM dbo.ChildTable) AS k
GROUP BY k.join_key
HAVING COUNT(*) > 1;

-- 9. Null and cardinality profile for one column (read-only, safe on any size).
SELECT COUNT(*) AS total_rows,
       COUNT(col) AS non_null_rows,
       COUNT(*) - COUNT(col) AS null_rows,
       CAST(100.0 * (COUNT(*) - COUNT(col)) / NULLIF(COUNT(*), 0) AS decimal(5, 2)) AS null_pct,
       COUNT(DISTINCT col) AS distinct_values
FROM dbo.TargetTable;

-- 10. View / procedure / function definitions.
SELECT o.name,
       o.type_desc,
       OBJECT_DEFINITION(o.object_id) AS definition
FROM sys.objects AS o
WHERE o.is_ms_shipped = 0
  AND o.type IN ('V', 'P', 'FN', 'IF', 'TF', 'TR')
ORDER BY o.type_desc, o.name;