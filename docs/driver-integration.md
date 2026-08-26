# Driver Integration Harness (real servers)

Proves each self-hostable engine genuinely connects, runs round trips and
disconnects through the app's own driver code paths (`XxxDriver::connect`),
not mocks.

## Covered

| Engine | Wire | Scope |
|---|---|---|
| PostgreSQL 16 | TCP 5432 wire | connect, ping, create/insert/count |
| MySQL 8 / MariaDB 11 | MySQL wire | same CRUD contract |
| ClickHouse 24 | HTTP 8123 | same CRUD contract |
| SQL Server 2022 (`heavy`) | TDS 7.3 | same CRUD contract |
| Cassandra wire via ScyllaDB 5.2 (`heavy`) | CQL | connect, ping, `SELECT ... FROM system.local` |
| Redis 7 | RESP + PING | connect, ping, keyspace scan |
| MongoDB 7 | BSON handshake + ping:1 | connect, ping, list databases |
| SQLite / DuckDB | file | local file round trip (no server) |

Heavy engines need the compose `heavy` profile plus opt-in env vars
`TABLER_IT_MSSQL=1`, `TABLER_IT_CASSANDRA=1` (`npm run test:integration:heavy`
sets both).

Cloud-only engines (Snowflake, BigQuery, Cloudflare D1, remote LibSQL) and
plugin-gated OpenSearch cannot be self-hosted here; they are excluded by
design.

## Run

```bash
npm run test:integration:drivers           # core engines
npm run test:integration:drivers -- --keep # leave containers running
npm run test:integration:heavy             # additionally MSSQL + ScyllaDB
```

Or manually:

```bash
docker compose -f docker-compose.integration.yml up -d --wait
TABLER_DRIVER_INTEGRATION=1 cargo test --test driver_integration
docker compose -f docker-compose.integration.yml down
```

Without `TABLER_DRIVER_INTEGRATION=1` the tests skip in seconds so the
normal `cargo test` stays fast and green.
