# ANSI ↔ T-SQL keyword and function map

Use this table when converting a statement written for another engine, or when the
model's first instinct is a keyword that does not exist in SQL Server.

## Clauses

| Intent                          | ANSI / PostgreSQL      | MySQL               | T-SQL                                                       |
| ------------------------------- | ---------------------- | ------------------- | ----------------------------------------------------------- |
| Row limit                       | `LIMIT n`              | `LIMIT n`           | `TOP (n)`                                                   |
| Row limit + offset              | `LIMIT n OFFSET m`     | `LIMIT m, n`        | `OFFSET m ROWS FETCH NEXT n ROWS ONLY` (needs `ORDER BY`)   |
| Identifier quoting              | `"col"`                | `` `col` ``         | `[col]`                                                     |
| String concatenation            | `                      |                     | `                                                           | `CONCAT()` | `+` (NULL-poisoning) or `CONCAT()` |
| Case-sensitive collation inline | `COLLATE "C"`          | `COLLATE utf8_bin`  | `COLLATE Latin1_General_CS_AS`                              |
| Boolean literals                | `TRUE` / `FALSE`       | `1` / `0`           | `1` / `0` (`bit`)                                           |
| Type cast                       | `CAST(x AS int)`       | `CAST(x AS SIGNED)` | `CAST(x AS int)` / `CONVERT(int, x)`                        |
| Null replacement                | `COALESCE`             | `IFNULL`            | `ISNULL` (2 args) / `COALESCE`                              |
| Null-safe equality              | `IS NOT DISTINCT FROM` | `<=>`               | `INTERSECT` idiom or `(a = b OR (a IS NULL AND b IS NULL))` |

## Functions

| Intent              | PostgreSQL                        | MySQL                         | T-SQL                                           |
| ------------------- | --------------------------------- | ----------------------------- | ----------------------------------------------- |
| Current timestamp   | `NOW()`                           | `NOW()`                       | `SYSDATETIME()` / `SYSUTCDATETIME()`            |
| Current date only   | `CURRENT_DATE`                    | `CURDATE()`                   | `CAST(SYSDATETIME() AS date)`                   |
| UTC now             | `NOW() AT TIME ZONE 'UTC'`        | `UTC_TIMESTAMP()`             | `SYSUTCDATETIME()`                              |
| Add interval        | `d + INTERVAL '1 day'`            | `DATE_ADD(d, INTERVAL 1 DAY)` | `DATEADD(day, 1, d)`                            |
| Difference          | `DATE_PART('day', a - b)`         | `DATEDIFF(a, b)`              | `DATEDIFF(day, b, a)` (note arg order)          |
| Truncate to day     | `DATE_TRUNC('day', d)`            | `DATE(d)`                     | `CAST(d AS date)`                               |
| Format date         | `to_char(d, 'YYYY-MM-DD')`        | `DATE_FORMAT(d, '%Y-%m-%d')`  | `CONVERT(varchar(10), d, 23)` (23 = ISO)        |
| Parse text to date  | `d::date`                         | `STR_TO_DATE`                 | `TRY_CONVERT(date, s)`                          |
| String length       | `length(s)`                       | `CHAR_LENGTH(s)`              | `LEN(s)` (trailing spaces ignored)              |
| Substring           | `substring(s, 1, 3)`              | `SUBSTRING(s, 1, 3)`          | `SUBSTRING(s, 1, 3)`                            |
| Position            | `position('x' in s)`              | `INSTR(s, 'x')`               | `CHARINDEX('x', s)`                             |
| Uppercase           | `upper(s)`                        | `UPPER(s)`                    | `UPPER(s)`                                      |
| Trim                | `trim(s)`                         | `TRIM(s)`                     | `LTRIM(RTRIM(s))` / `TRIM(s)` (2017+)           |
| Replace             | `replace(s, a, b)`                | `REPLACE(s, a, b)`            | `REPLACE(s, a, b)`                              |
| Split to rows       | `unnest(string_to_array(s, ','))` | JSON_TABLE                    | `STRING_SPLIT(s, ',')` (2016+)                  |
| Aggregate to string | `string_agg(x, ',')`              | `GROUP_CONCAT(x)`             | `STRING_AGG(x, ',')` (2017+)                    |
| Hash                | `md5(s)`                          | `MD5(s)`                      | `HASHBYTES('MD5', s)`                           |
| Random              | `random()`                        | `RAND()`                      | `RAND()` / `NEWID()`                            |
| Regex match         | `s ~ 'p'`                         | `s REGEXP 'p'`                | no native regex — use `LIKE` or `PATINDEX`      |
| Generate series     | `generate_series(1, 10)`          | recursive CTE                 | recursive CTE or `master..spt_values`           |
| Greatest of list    | `GREATEST(a, b)`                  | `GREATEST(a, b)`              | `(SELECT MAX(v) FROM (VALUES (a),(b)) AS x(v))` |
| Least of list       | `LEAST(a, b)`                     | `LEAST(a, b)`                 | `(SELECT MIN(v) FROM (VALUES (a),(b)) AS x(v))` |

## Aggregates and window functions

| Intent                      | PostgreSQL                      | T-SQL                                                    |
| --------------------------- | ------------------------------- | -------------------------------------------------------- |
| Group concat with order     | `string_agg(x, ',' ORDER BY y)` | `STRING_AGG(x, ',') WITHIN GROUP (ORDER BY y)`           |
| Percentile                  | `percentile_cont(0.5)`          | `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) OVER ()` |
| Filtered aggregate          | `count(*) FILTER (WHERE p)`     | `COUNT(CASE WHEN p THEN 1 END)`                          |
| Distinct count              | `count(DISTINCT x)`             | `COUNT(DISTINCT x)`                                      |
| Running total               | `sum(x) OVER (ORDER BY y)`      | `SUM(x) OVER (ORDER BY y ROWS UNBOUNDED PRECEDING)`      |
| Row numbering               | `row_number() OVER (…)`         | `ROW_NUMBER() OVER (…)`                                  |
| Previous row                | `lag(x) OVER (…)`               | `LAG(x) OVER (…)` (2012+)                                |
| Grouped string of live rows | `bool_and(p)`                   | `MIN(CASE WHEN p THEN 1 ELSE 0 END)`                     |

## Metadata / catalog queries

| Intent             | PostgreSQL                   | MySQL                                        | T-SQL                                                         |
| ------------------ | ---------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| List tables        | `information_schema.tables`  | `information_schema.tables`                  | `sys.tables` or `INFORMATION_SCHEMA.TABLES`                   |
| List columns       | `information_schema.columns` | `information_schema.columns`                 | `sys.columns` joined to `sys.types`                           |
| Primary key        | `pg_index`                   | `information_schema.key_column_usage`        | `sys.key_constraints` + `sys.index_columns`                   |
| Foreign keys       | `pg_constraint`              | `information_schema.referential_constraints` | `sys.foreign_keys` + `sys.foreign_key_columns`                |
| Indexes            | `pg_indexes`                 | `SHOW INDEX`                                 | `sys.indexes` + `sys.index_columns`                           |
| Row count estimate | `pg_class.reltuples`         | `information_schema.tables.table_rows`       | `sys.dm_db_partition_stats` (never `COUNT(*)` on a big table) |
| Object definition  | `pg_get_viewdef`             | `SHOW CREATE VIEW`                           | `OBJECT_DEFINITION(OBJECT_ID('v'))`                           |
| Current database   | `current_database()`         | `DATABASE()`                                 | `DB_NAME()`                                                   |
| Current schema     | `current_schema()`           | `DATABASE()`                                 | `SCHEMA_NAME()`                                               |

## See also

- `scripts/catalog-queries.sql` — ready-to-run `sys.*` introspection queries for schema
  discovery, index inventory, foreign-key mapping, and missing-index hints.
- `gotchas.md` — correctness traps that this map does not cover.
