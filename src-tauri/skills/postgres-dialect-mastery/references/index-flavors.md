# PostgreSQL index flavors — beyond the plain B-tree

Companion to the `postgres-dialect-mastery` skill. The main skill covers upsert,
`RETURNING`, types, and plan reading; this reference is the index vocabulary — the five
flavors people forget to create, and the one trap (foreign keys) they all hit.

## Partial index — index a slice of the table

```sql
CREATE INDEX idx_orders_active ON orders (user_id, created_at)
WHERE status NOT IN ('delivered', 'cancelled');
```

- The index holds only rows matching the `WHERE` — smaller, hotter in cache, and
  cheaper to maintain on writes outside the slice.
- The planner uses it **only** when the query's predicate implies the index's
  predicate. `WHERE status = 'pending'` can use it; a bare `WHERE user_id = 42`
  cannot.
- Classic wins: "active rows" flags, `WHERE deleted_at IS NULL` soft-delete filters,
  unprocessed-queue tables where 99% of rows are done.

## Expression index — index a function's output

```sql
CREATE INDEX idx_users_email_lower ON users (lower(email));
```

- The expression in the index must **match the query exactly**: `WHERE lower(email) = ?`
  uses it; `WHERE email = ?` does not, and neither does `lower(email) = lower(?)` if the
  index was built on a different expression shape.
- Fixes the two most common non-sargable predicates: `lower(col)` lookups and
  `col::date = ?` casts. Creating the index is usually cheaper than rewriting every
  caller — but pick one convention and index that one.
- `CREATE INDEX ... ON t ((col->>'status'))` — expression indexes also cover JSONB text
  access; wrap the expression in extra parentheses in the DDL.

## Covering index (`INCLUDE`) — index-only scans

```sql
CREATE INDEX idx_orders_user_covering ON orders (user_id) INCLUDE (total, created_at);
```

- The `INCLUDE` columns live in the index but are not part of the key order — they exist
  so the query can be answered from the index alone.
- In `EXPLAIN (ANALYZE, BUFFERS)`, the win shows as `Index Only Scan` with low
  `Heap Fetches`. A plan showing `Index Scan` + repeated heap access per row is the
  candidate for this treatment.
- One caveat the plan will not show: visibility map maintenance. Frequent writes keep
  `Heap Fetches` high even with a perfect covering index; on very hot tables measure
  before claiming the win.

## GIN — JSONB, arrays, full text, trigram

- `CREATE INDEX idx_orders_metadata ON orders USING GIN (metadata);` — makes
  `metadata @> '{"source":"web"}'` and `?`/`?|`/`?&` operators index-backed.
- Arrays: `USING GIN (tags)` backs the `@>` and `&&` array operators.
- `pg_trgm`: `CREATE INDEX idx_names_trgm ON users USING GIN (name gin_trgm_ops);` —
  the only way to make `LIKE '%term%'` seekable. Without it, leading-wildcard `LIKE`
  is a guaranteed scan.
- Cost: GIN indexes are larger and slower to update than B-trees. On write-heavy tables,
  say so when proposing one.

## BRIN — huge append-only tables

- `CREATE INDEX idx_events_ts_brin ON events USING BRIN (created_at);`
- Stores per-block min/max instead of per-row keys: kilobytes instead of gigabytes on
  time-series or log tables where rows land roughly in time order.
- Only helps when physical order correlates with the predicate — random updates destroy
  that correlation. State that precondition when proposing BRIN.

## The trap: foreign keys are not auto-indexed

Unlike MySQL/InnoDB, PostgreSQL creates **no** index for a foreign key. Consequences:

- `ON DELETE CASCADE` on the parent runs a **sequential scan of the child** per deleted
  parent row. Deleting one row from `users` with 10M `orders` rows and no index on
  `orders.user_id` scans 10M rows to find children.
- Every join `child JOIN parent ON child.parent_id = parent.id` wants that index too.
- Rule: after `describe_table` shows an FK, check the child's index list for the FK
  columns and propose one when missing. The `run_preset` `index-usage` preset is the
  sanctioned way to see which indexes exist and which are unused — the tool contract
  directs server-state questions there rather than to catalog SQL such as
  `pg_stat_user_indexes`.

## Naming and verification

- `CREATE UNIQUE INDEX` backs both uniqueness and the `ON CONFLICT (col)` target — the
  main skill's upsert section depends on this.
- `CREATE INDEX CONCURRENTLY` avoids the write-blocking build but cannot run inside a
  transaction block (the main skill notes this for the write path).
- After proposing an index, always propose the `EXPLAIN` that proves the shape changed
  (seek instead of scan) — an index that does not change the plan is dead weight.
