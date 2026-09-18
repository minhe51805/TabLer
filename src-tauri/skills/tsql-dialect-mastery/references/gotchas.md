# T-SQL correctness gotchas

Each entry is a silent-wrong-answer trap: the statement runs, returns rows, and is
still not what the user meant. Check these before presenting a result.

## 1. `NOT IN` with a NULL in the subquery returns _no rows_

```sql
-- If any RegionId in Sales.Region is NULL, this returns ZERO rows.
SELECT * FROM dbo.Customer WHERE RegionId NOT IN (SELECT RegionId FROM Sales.Region);
```

Use `NOT EXISTS`, which is NULL-safe:

```sql
SELECT * FROM dbo.Customer c
WHERE NOT EXISTS (SELECT 1 FROM Sales.Region r WHERE r.RegionId = c.RegionId);
```

Same hazard applies to `<> ALL (…subt tf)`.

## 2. `COUNT(*)` vs `COUNT(col)`

`COUNT(*)` counts rows; `COUNT(col)` counts non-NULL values. A "how many rows?" answer
built with `COUNT(col)` under-reports whenever the column is nullable. When computing a
null percentage, use both: `COUNT(*) - COUNT(col)` is the NULL count.

## 3. `AVG` and integer division

`AVG` over an `int` column performs **integer** division and truncates. Multiply by
`1.0` or cast: `AVG(CAST(amount AS decimal(18,4)))`. The same applies to `/` between two
integers.

## 4. Trailing spaces are ignored in `=` but not in `LIKE`

SQL Server follows ANSI padding: `'abc' = 'abc   '` is TRUE, and `LEN('abc   ')` is 3.
`DATALENGTH('abc   ')` is 6. Use `DATALENGTH` when trailing whitespace matters, and
remember `LIKE 'abc'` does **not** match `'abc '` the same way `=` does.

## 5. `TOP (n)` with ties is non-deterministic

`SELECT TOP (10) …` without `ORDER BY` returns an arbitrary 10 rows, and with
`ORDER BY` it still picks arbitrarily among ties on the sort key. When the caller
expects a stable answer, add a unique tiebreaker to `ORDER BY` (usually the primary
key), or use `WITH TIES`.

## 6. `ORDER BY` in a subquery is not a guarantee

`SELECT * FROM (SELECT TOP 5 … ORDER BY x) t` is fine, but a bare `ORDER BY` inside a
derived table with no `TOP` is discarded by the optimizer. Always pair `ORDER BY` with
`TOP` or `OFFSET/FETCH` when the order is meant to matter.

## 7. String → date/number comparison forces a scan _and_ can fail at runtime

```sql
-- Bad: implicit conversion on the column, plan-wide scan risk
SELECT * FROM dbo.Orders WHERE OrderDate = '2024-13-01';
```

Compare against a properly typed literal/parameter
(`TRY_CONVERT(date, @raw)`), and keep the column side bare. Both the plan and the
error behavior change when the column is wrapped in a function or an implicit cast.

## 8. `datetime` rounding: 0, 3, 7 ms

Legacy `datetime` rounds to 1/300 s. A value stored as `23:59:59.999` becomes
`00:00:00.000` of the _next_ day. Use half-open ranges for date windows:

```sql
WHERE OrderDate >= @startDate AND OrderDate < DATEADD(day, 1, @endDate)
```

Never `BETWEEN` with `23:59:59.997` — it is a workaround, not a definition, and it
breaks on `datetime2`.

## 9. Collation: comparisons can fail or mis-sort across columns

Comparing two columns with different collations raises
"Cannot resolve the collation conflict". Comparisons in a `Latin1_General_CS_AS` database
are case- and accent-sensitive, so `'A' = 'a'` is FALSE. When a result depends on
case-insensitivity, state it explicitly:

```sql
WHERE Name COLLATE Latin1_General_CI_AS = @name
```

## 10. `UPDATE` with a join updates only once per target row

`UPDATE t SET x = s.x FROM t JOIN s ON …` picks an arbitrary matching `s` row per `t`
row when the join is one-to-many — no error, no warning. Verify the join is unique
(with `COUNT(*)`/`GROUP BY`) before running it.

## 11. `DELETE TOP (n)` needs the same caution as `SELECT TOP (n)`

It has no `ORDER BY`, so "delete the 100 oldest" is not what `DELETE TOP (100)` means.
Select the keys first, then delete by key list inside a transaction.

## 12. `IDENTITY` gaps are normal

Rollbacks, deletes, and restarts leave gaps in an `IDENTITY` column. A gap is not
evidence of a missing row. Do not "repair" identity seeds without being asked.

## 13. `TRUNCATE TABLE` restrictions

It fails on a table referenced by a foreign key, on a table part of an indexed view,
and on a table with a replication/merge article. It also cannot be filtered and
resets the identity seed. `DELETE` with no `WHERE` is logged row-by-row and can be
rolled back; `TRUNCATE` cannot be rolled back the same way — treat them as different
operations, not synonyms.

## 14. `SET NOCOUNT` and driver row counts

Without `SET NOCOUNT ON`, DML statements return a "rows affected" result set that some
clients misinterpret as data. It is also the classic cause of "the statement returned a
count instead of my SELECT" bugs when concatenating batches.

## 15. `ISNULL(bit, 0)` vs `CAST`

`ISNULL` returns the type of its first argument; `CAST`/`COALESCE` promote. In a
`CASE`/`UNION` this changes the result column type and can truncate silently
(`ISNULL(varchar(10)_col, 'long default')` truncates the default).

## 16. `MERGE` correctness bugs

`MERGE` can raise a duplicate-key error under concurrency, may update the same row
twice when the source has duplicate keys, and its `OUTPUT` clause historically
mis-reported. Prefer:

```sql
BEGIN TRAN;
UPDATE t SET … FROM … WHERE …;
IF @@ROWCOUNT = 0 INSERT …;
COMMIT;
```

## See also

- `keyword-map.md` — translation table for statements coming from another dialect.
- `scripts/catalog-queries.sql` — introspection queries used to verify assumptions
  (uniqueness, nullability, key structure) before a write.
