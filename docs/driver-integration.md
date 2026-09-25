# Driver Integration Harness (real servers)

Proves each self-hostable engine genuinely connects, runs round trips and
disconnects through the app's own driver code paths (`XxxDriver::connect`),
not mocks.

## Covered

| Engine                                    | Wire                    | Scope                                         |
| ----------------------------------------- | ----------------------- | --------------------------------------------- |
| PostgreSQL 16                             | TCP 5432 wire           | connect, ping, create/insert/count            |
| MySQL 8 / MariaDB 11                      | MySQL wire              | same CRUD contract                            |
| ClickHouse 24                             | HTTP 8123               | same CRUD contract                            |
| SQL Server 2022 (`heavy`)                 | TDS 7.3                 | same CRUD contract                            |
| Cassandra wire via ScyllaDB 5.2 (`heavy`) | CQL                     | connect, ping, `SELECT ... FROM system.local` |
| Redis 7                                   | RESP + PING             | connect, ping, keyspace scan                  |
| MongoDB 7                                 | BSON handshake + ping:1 | connect, ping, list databases                 |
| SQLite / DuckDB                           | file                    | local file round trip (no server)             |

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

## Roadmap — engines not yet supported

Audit-driven gap list (client review 2026-09-25). Each new engine = a
`DatabaseDriver` impl + capability-matrix row + driver-integration entry here.
Ordered by likely user value, not alphabetically:

| Engine        | Wire                  | Notes                                                                                                                    |
| ------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Kafka         | TCP 9092 / librdkafka | Log/topic browser; write path = produce, not CRUD rows. Needs a "streaming" capability shape the grid doesn't model yet. |
| Weaviate      | gRPC/HTTP 8080        | Vector DB; schema = classes, rows = objects. Closest existing precedent: the `opensearch` driver.                        |
| Typesense     | HTTP 8108             | Search engine, document-oriented. Smallest driver surface of the six.                                                    |
| Dameng (DM)   | DM wire / ODBC        | Chinese enterprise DB; no mature pure-Rust driver — would need ODBC bridge or sidecar. Highest effort.                   |
| Elasticsearch | HTTP 9200             | `elasticsearch.rs` exists in-tree (stub/partial); finish it rather than treating as new.                                 |
| SurrealDB     | WS 8000               | `surrealdb.rs` exists in-tree (stub/partial); same — finish, don't re-add.                                               |

Already present but feature-gated or partial: `surrealdb.rs`, `elasticsearch.rs`,
`opensearch.rs`, `dynamodb.rs`, `spanner.rs`, `trino.rs`, `snowflake.rs`,
`bigquery.rs`, `clickhouse.rs`, `cloudflare_d1.rs`. Check `database/capabilities.rs`
before adding — several are declared but tiered `N/A` or `U` on write paths.
