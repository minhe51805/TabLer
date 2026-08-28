# Query lifecycle

How TableR runs, times out, and cancels a SQL statement.

## Execute

1. Frontend `queryStore` creates a `requestId` and stores the active `connectionId`.
2. A Tauri command (`execute_query`, `execute_parameterized_query`, `execute_sandboxed_query`, `execute_agent_readonly_query`) registers a `CancellationToken` for that `requestId`.
3. If a `request_id` is present, the driver `execute_query_for_request` (or parameterized equivalent) is used.
4. Postgres and MySQL acquire a **dedicated pool connection**, read `pg_backend_pid()` / `CONNECTION_ID()`, register it, then run the user SQL on that connection.
5. Other drivers ignore the request id and call `execute_query` (local cancel only).

## Timeout

`timeout_for_statements` classifies the whole batch:

- read-only → 180 seconds
- any mutating/schema statement (including mutating CTEs) → 60 seconds

A mixed batch does **not** get the read-only window.

## Cancel

1. UI calls `cancel_query` with `{ requestId, connectionId }`.
2. The token is cancelled so the waiting future unblocks (`Query cancelled.`).
3. The same driver instance looks up the backend id and issues:
   - Postgres: `SELECT pg_cancel_backend($1)` on a **new** pool connection
   - MySQL/MariaDB: `KILL QUERY <id>` on a **new** pool connection
4. If cancel arrives before the backend id is registered, the registry marks the request pending and the execute path aborts before starting user SQL.
5. A `Drop` guard always removes the registry entry, including on timeout and panic-unwind.

## Pool

Postgres and MySQL pools are capped at **8** connections (`max_connections`). Cancel uses a second connection so it does not wait behind the in-flight query. Desktop usage is single-user; dedicated connections during cancellable queries are acceptable.

## SQLite

sqlx 0.8.6 does not expose a public interrupt API. Cancel stops waiting in TableR; the embedded engine may finish the statement in the background. Capability remains `limited`.
