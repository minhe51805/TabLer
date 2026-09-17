---
name: migration-authoring
description: This skill should be used when the user asks to "write a migration", "add a column", "alter a table", "backfill data", or "make DDL idempotent".
version: 1.0.0
license: MIT
---

# Migration Authoring

Use this for any schema change or data backfill. The goal is a script that is
**safe to re-run**, **additive first**, and **reversible** — the three properties that
make a migration survivable on a real database.

## The four rules

1. **Idempotent.** Re-running the migration must be a no-op, not an error. Never rely on
   "it will only run once" — reruns happen after a failed partial apply.
2. **Additive first.** Add before you change; change before you remove. A migration that
   drops a column in the same step that adds its replacement has no safe rollback.
3. **Bounded locks.** `ALTER TABLE` takes a schema-modification lock. Know the table size
   (`sys.dm_db_partition_stats`) before you run it, and say the size out loud.
4. **Verifiable.** Every step ends with a query that proves the step applied. A migration
   reported without a verification query is an unverified claim.

## Idempotent guard patterns (T-SQL)

```sql
-- Table
IF OBJECT_ID(N'dbo.orders', N'U') IS NULL
    CREATE TABLE dbo.orders (id INT NOT NULL PRIMARY KEY);

-- Column
IF COL_LENGTH(N'dbo.orders', N'status') IS NULL
    ALTER TABLE dbo.orders ADD status NVARCHAR(32) NULL;

-- Index
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'IX_orders_status' AND object_id = OBJECT_ID(N'dbo.orders'))
    CREATE INDEX IX_orders_status ON dbo.orders (status);

-- Foreign key
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_orders_customer')
    ALTER TABLE dbo.orders ADD CONSTRAINT FK_orders_customer
        FOREIGN KEY (customer_id) REFERENCES dbo.customer (id);

-- Constraint
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_orders_total')
    ALTER TABLE dbo.orders ADD CONSTRAINT CK_orders_total CHECK (total >= 0);
```

Note the pattern: guard on the **object name**, not on a try/catch. Catching a duplicate
error works until the error is something else.

## Adding a column safely

| Situation                       | Correct form                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Table has rows, column optional | `ADD col T NULL`                                                                                      |
| Table has rows, column required | `ADD col T NOT NULL CONSTRAINT DF_x DEFAULT (...)`, then drop the default if it was only for backfill |
| Table is empty (verified)       | `ADD col T NOT NULL` is fine — but verify the emptiness first                                         |
| Column must be unique           | Add nullable, backfill, then add a **filtered** unique index where the column is not null             |

Never add `NOT NULL` without a default to a table with rows: it fails, and on some
engines it silently takes the default for existing rows in a way you did not intend.

## Backfilling in batches

A single `UPDATE` over millions of rows holds one long transaction, bloats the log, and
blocks readers. Batch it:

```sql
DECLARE @batch INT = 10000;
WHILE 1 = 1
BEGIN
    UPDATE TOP (@batch) dbo.orders
       SET status = N'unknown'
     WHERE status IS NULL;
    IF @@ROWCOUNT = 0 BREAK;
    -- Optional: WAITFOR DELAY '00:00:00.100'; to yield to other writers.
END
```

Rules for a backfill: it must be **restartable** (the `WHERE` finds only unprocessed
rows), **idempotent** (running it twice converges), and **observable** (report rows
processed per batch).

## Removing things

- Dropping a column is a **two-release** operation: stop using it, ship, then drop it.
  Dropping in the same release that stops using it removes your rollback path.
- Before dropping, check dependants and report them rather than discovering them:

```sql
SELECT referencing_entity_name, referenced_minor_name
FROM sys.sql_expression_dependencies
WHERE referenced_id = OBJECT_ID(N'dbo.orders');
```

- Dropping an index is cheap and safe; dropping a constraint that enforces correctness
  is not — say which one you are doing.

## Recommended output shape

Present a migration as ordered, individually-verifiable steps:

```
Step 1  ADD COLUMN status NVARCHAR(32) NULL        → verify: COL_LENGTH is not null
Step 2  Backfill in batches (10k)                  → verify: COUNT(*) WHERE status IS NULL = 0
Step 3  ADD CONSTRAINT CK_orders_status CHECK(...) → verify: sys.check_constraints row exists
Step 4  (later release) DROP COLUMN legacy_status  → verify: COL_LENGTH is null
```

Each step gets its own verification query. If a step cannot be verified, it is not ready.

## See also

- `tsql-dialect-mastery` — DDL dialect traps (`GO` batching, `ALTER COLUMN` restrictions).
- `tsql-safety-guardrails` — the preview/checkpoint discipline for the data parts.
- `references/idempotent-ddl.md` — the full guard-pattern catalogue per object type.
