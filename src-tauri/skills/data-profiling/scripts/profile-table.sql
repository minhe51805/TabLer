-- Read-only profiling queries. Every statement here is a SELECT and is safe to run
-- with run_readonly_sql. Replace dbo.TargetTable and the column list with real names
-- taken from describe_table output — do not guess column names.

-- 1. Row count WITHOUT COUNT(*) — uses partition stats, instant on any table size.
SELECT SUM(p.row_count) AS row_count,
       CAST(SUM(p.used_page_count) * 8.0 / 1024 AS decimal(18, 2)) AS used_mb
FROM sys.dm_db_partition_stats AS p
WHERE p.object_id = OBJECT_ID('dbo.TargetTable')
  AND p.index_id IN (0, 1);

-- 2. Single-pass profile: one table scan produces every cheap aggregate.
--    Add or remove columns to match the request; keep it to one statement so the
--    table is scanned once instead of once per check.
SELECT COUNT(*)                                                      AS total_rows,
       COUNT(col_a)                                                  AS col_a_non_null,
       COUNT(*) - COUNT(col_a)                                       AS col_a_nulls,
       CAST(100.0 * (COUNT(*) - COUNT(col_a)) / NULLIF(COUNT(*), 0) AS decimal(5, 2))
                                                                     AS col_a_null_pct,
       MIN(col_b)                                                    AS col_b_min,
       MAX(col_b)                                                    AS col_b_max,
       MIN(col_c)                                                    AS col_c_min,
       MAX(col_c)                                                    AS col_c_max,
       COUNT(*) - COUNT(NULLIF(col_d, ''))                           AS col_d_blank_or_null
FROM dbo.TargetTable;

-- 3. Distinct cardinality — run only for columns the request cares about; this is the
--    expensive check, so keep it to a few columns and avoid it on huge tables.
SELECT COUNT(DISTINCT col_a) AS col_a_distinct,
       COUNT(DISTINCT col_b) AS col_b_distinct
FROM dbo.TargetTable;

-- 4. A column that is effectively a constant (min = max) is a modelling smell.
SELECT MIN(col_a) AS min_value, MAX(col_a) AS max_value
FROM dbo.TargetTable;

-- 5. Duplicate detection on the intended key. Expect ZERO rows; any row returned means
--    "one row per key" assumptions elsewhere are unsafe (breaks UPDATE…FROM JOIN).
SELECT key_col, COUNT(*) AS duplicates
FROM dbo.TargetTable
GROUP BY key_col
HAVING COUNT(*) > 1;

-- 6. Orphan foreign keys: child rows whose parent does not exist.
SELECT COUNT(*) AS orphan_rows
FROM dbo.ChildTable AS c
LEFT JOIN dbo.ParentTable AS p ON p.parent_key = c.parent_key
WHERE p.parent_key IS NULL;

-- 7. Low-cardinality distribution (status/enum columns). Bounded to the top 20 values.
SELECT TOP (20) status_col, COUNT(*) AS rows_in_status
FROM dbo.TargetTable
GROUP BY status_col
ORDER BY rows_in_status DESC;

-- 8. Distinct-value discovery when the domain is unknown, bounded to 200 values.
SELECT DISTINCT TOP (200) status_col
FROM dbo.TargetTable
ORDER BY status_col;

-- 9. Placeholder / sentinel value scan. Adjust the literal list per column type.
SELECT SUM(CASE WHEN col_a = '' THEN 1 ELSE 0 END)      AS empty_string_rows,
       SUM(CASE WHEN col_a IS NULL THEN 1 ELSE 0 END)   AS null_rows,
       SUM(CASE WHEN col_b = '1900-01-01' THEN 1 ELSE 0 END) AS epoch_default_rows,
       SUM(CASE WHEN col_c = -1 THEN 1 ELSE 0 END)      AS negative_one_rows
FROM dbo.TargetTable;

-- 10. Sampled profile for a very large table — always label results as sampled.
--     TABLESAMPLE returns an approximate, non-deterministic sample.
SELECT COUNT(*) AS sampled_rows,
       COUNT(col_a) AS col_a_non_null,
       AVG(CAST(col_b AS decimal(18, 4))) AS col_b_avg
FROM dbo.TargetTable TABLESAMPLE SYSTEM (1 PERCENT);

-- 11. Freshness: how stale is the data, and is there a usable timestamp column?
SELECT MIN(created_at) AS earliest_row,
       MAX(created_at) AS latest_row,
       DATEDIFF(day, MAX(created_at), SYSUTCDATETIME()) AS days_since_latest
FROM dbo.TargetTable;

-- 12. Composite-key duplicate check (multi-column business key).
SELECT col_a, col_b, COUNT(*) AS duplicates
FROM dbo.TargetTable
GROUP BY col_a, col_b
HAVING COUNT(*) > 1;