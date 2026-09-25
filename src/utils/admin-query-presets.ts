import type { DatabaseType } from "../types";

export type AdminQueryKind =
  | "process-list"
  | "user-management"
  | "kill-session"
  | "server-info"
  | "locks"
  | "table-stats"
  | "index-usage"
  | "slow-queries";

/** Preset kinds in menu order — the AI run_preset tool advertises exactly
 *  this list. */
export const ADMIN_PRESET_KINDS: readonly AdminQueryKind[] = [
  "process-list",
  "user-management",
  "server-info",
  "locks",
  "table-stats",
  "index-usage",
  "slow-queries",
  "kill-session",
];

export interface AdminQueryPreset {
  supported: boolean;
  content: string;
  reason?: string;
}

function unsupported(reason: string): AdminQueryPreset {
  return {
    supported: false,
    content: "",
    reason,
  };
}

const PROCESS_LIST_PRESETS: Partial<Record<DatabaseType, AdminQueryPreset>> = {
  mysql: { supported: true, content: "SHOW FULL PROCESSLIST;" },
  mariadb: { supported: true, content: "SHOW FULL PROCESSLIST;" },
  postgresql: {
    supported: true,
    content:
      "SELECT pid, usename AS user_name, datname AS database_name, application_name, state, wait_event_type, wait_event, query_start, LEFT(query, 4000) AS query_text\nFROM pg_stat_activity\nWHERE pid <> pg_backend_pid()\nORDER BY query_start DESC NULLS LAST;",
  },
  greenplum: {
    supported: true,
    content:
      "SELECT pid, usename AS user_name, datname AS database_name, application_name, state, wait_event_type, wait_event, query_start, LEFT(query, 4000) AS query_text\nFROM pg_stat_activity\nWHERE pid <> pg_backend_pid()\nORDER BY query_start DESC NULLS LAST;",
  },
  redshift: {
    supported: true,
    content:
      "SELECT pid, user_name, db_name, start_time, status, TRIM(query) AS query_text\nFROM stv_recents\nORDER BY start_time DESC;",
  },
  cockroachdb: {
    supported: true,
    content: "SELECT *\nFROM crdb_internal.cluster_sessions;",
  },
  mssql: {
    supported: true,
    content:
      "SELECT s.session_id, s.login_name, s.host_name, s.program_name, s.status, DB_NAME(r.database_id) AS database_name, r.command, r.wait_type\nFROM sys.dm_exec_sessions s\nLEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id\nWHERE s.is_user_process = 1\nORDER BY s.session_id;",
  },
  redis: { supported: true, content: "CLIENT LIST" },
  mongodb: { supported: true, content: "db.adminCommand({ currentOp: true, $all: true })" },
  cassandra: { supported: true, content: "SELECT * FROM system_views.clients;" },
  vertica: {
    supported: true,
    content:
      "SELECT user_name, client_hostname, transaction_id, statement_id, request, query_start, current_statement\nFROM v_monitor.sessions\nORDER BY query_start DESC;",
  },
  clickhouse: {
    supported: true,
    content:
      "SELECT query_id, user, address, elapsed, read_rows, written_rows, query\nFROM system.processes\nORDER BY elapsed DESC;",
  },
  snowflake: {
    supported: true,
    content:
      "SELECT query_id, user_name, execution_status, start_time, query_text\nFROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY(RESULT_LIMIT => 50))\nORDER BY start_time DESC;",
  },
  trino: {
    supported: true,
    content:
      "SELECT query_id, user, state, source, started, query\nFROM system.runtime.queries\nORDER BY started DESC;",
  },
  spanner: {
    supported: true,
    content:
      "SELECT * FROM SPANNER_SYS.QUERY_STATS_TOP_MINUTE\nORDER BY EXECUTION_COUNT DESC\nLIMIT 50;",
  },
  bigquery: {
    supported: true,
    content:
      "SELECT job_id, user_email, state, query, start_time\nFROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT\nWHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)\nORDER BY start_time DESC\nLIMIT 50;",
  },
  oracle: {
    supported: true,
    content:
      "SELECT sid, serial#, username, status, sql_id, event, seconds_in_wait\nFROM v$session\nWHERE type = 'USER'\nORDER BY logon_time DESC;",
  },
  dynamodb: {
    supported: false,
    content: "",
    reason: "DynamoDB exposes no process list; use CloudWatch Contributor Insights externally.",
  },
  opensearch: {
    supported: true,
    content: "GET /_cat/tasks?format=json",
  },
  elasticsearch: {
    supported: true,
    content: "GET /_cat/tasks?format=json",
  },
  typesense: {
    supported: false,
    content: "",
    reason:
      "Typesense exposes no statement surface for live operations; task inspection is a per-node /operations GET the query surface cannot run.",
  },
  surrealdb: {
    supported: false,
    content: "",
    reason:
      "SurrealDB has no process list — INFO FOR DB reports schema structure, not running statements or sessions.",
  },
  weaviate: {
    supported: false,
    content: "",
    reason: "Weaviate exposes no process list or statement surface for running queries.",
  },
};

const USER_MANAGEMENT_PRESETS: Partial<Record<DatabaseType, AdminQueryPreset>> = {
  mysql: {
    supported: true,
    content:
      "SELECT User AS user_name, Host AS host_name, plugin\nFROM mysql.user\nORDER BY User, Host;",
  },
  mariadb: {
    supported: true,
    content:
      "SELECT User AS user_name, Host AS host_name, plugin\nFROM mysql.user\nORDER BY User, Host;",
  },
  postgresql: {
    supported: true,
    content:
      "SELECT usename AS user_name, usesuper AS is_superuser, usecreatedb AS can_create_db\nFROM pg_user\nORDER BY usename;",
  },
  greenplum: {
    supported: true,
    content:
      "SELECT usename AS user_name, usesuper AS is_superuser, usecreatedb AS can_create_db\nFROM pg_user\nORDER BY usename;",
  },
  redshift: {
    supported: true,
    content:
      "SELECT usename AS user_name, usesuper AS is_superuser, usecreatedb AS can_create_db\nFROM pg_user\nORDER BY usename;",
  },
  cockroachdb: {
    supported: true,
    content: "SELECT username\nFROM system.users\nORDER BY username;",
  },
  mssql: {
    supported: true,
    content:
      "SELECT name, type_desc, create_date, modify_date\nFROM sys.database_principals\nWHERE principal_id > 4\nORDER BY name;",
  },
  redis: { supported: true, content: "ACL LIST" },
  mongodb: { supported: true, content: 'db.getSiblingDB("admin").runCommand({ usersInfo: 1 })' },
  cassandra: {
    supported: true,
    content: "SELECT role, super, can_login\nFROM system_auth.roles;",
  },
  vertica: {
    supported: true,
    content: "SELECT user_name, is_super_user, locked\nFROM users\nORDER BY user_name;",
  },
  clickhouse: {
    supported: true,
    content: "SELECT name, storage, auth_type\nFROM system.users\nORDER BY name;",
  },
  snowflake: {
    supported: true,
    content:
      "SELECT name, login_name, display_name, type, disabled, has_password, has_mfa\nFROM SNOWFLAKE.ACCOUNT_USAGE.USERS\nWHERE deleted_on IS NULL\nORDER BY name;",
  },
  trino: {
    supported: false,
    content: "",
    reason:
      "Trino delegates authentication to the configured authenticator (LDAP/OAuth2/password file); there is no user catalog to query.",
  },
  spanner: {
    supported: false,
    content: "",
    reason: "Spanner access is managed by Cloud IAM, not in-database users.",
  },
  bigquery: {
    supported: false,
    content: "",
    reason: "BigQuery access is managed by Cloud IAM, not in-database users.",
  },
  oracle: {
    supported: true,
    content:
      "SELECT username, account_status, default_tablespace, created\nFROM dba_users\nORDER BY username;",
  },
  dynamodb: {
    supported: false,
    content: "",
    reason: "DynamoDB access is managed by AWS IAM, not in-database users.",
  },
  elasticsearch: {
    supported: false,
    content: "",
    reason:
      "Elasticsearch security runs through the X-Pack _security REST API; user administration is not integrated.",
  },
  typesense: {
    supported: false,
    content: "",
    reason:
      "Typesense authentication is API-key based; key administration lives in the /keys REST API, not in-database users.",
  },
  surrealdb: {
    supported: false,
    content: "",
    reason:
      "SurrealDB authentication runs through scoped access definitions and system users; user administration is not integrated.",
  },
  weaviate: {
    supported: false,
    content: "",
    reason:
      "Weaviate uses a static API key (or external OIDC); there is no in-database user catalog to query.",
  },
};

/**
 * Kill-session presets use `{{param}}` placeholders — the same grammar the
 * SQL editor's ParamFillDialog resolves (`src/utils/sql-params.ts`), so the
 * menu item can open a query tab and let the normal run path prompt for the
 * session id, show the resolved statement, and pass it through the standard
 * write/safe-mode gates. `:int` params render unquoted; default (string)
 * params render as a quoted literal, so presets must NOT add their own quotes
 * around `{{session_id}}`. Oracle needs sid+serial# — two int params
 * substituted inside a single quoted literal.
 */
const KILL_SESSION_PRESETS: Partial<Record<DatabaseType, AdminQueryPreset>> = {
  mysql: { supported: true, content: "KILL {{session_id:int}};" },
  mariadb: { supported: true, content: "KILL {{session_id:int}};" },
  postgresql: {
    supported: true,
    content: "SELECT pg_terminate_backend({{session_id:int}}) AS terminated;",
  },
  greenplum: {
    supported: true,
    content: "SELECT pg_terminate_backend({{session_id:int}}) AS terminated;",
  },
  redshift: {
    supported: true,
    content: "SELECT pg_terminate_backend({{session_id:int}}) AS terminated;",
  },
  // CockroachDB does not implement pg_terminate_backend (distributed SQL, no
  // per-node backends); the native CANCEL SESSION takes the hex session id.
  cockroachdb: {
    supported: true,
    content: "CANCEL SESSION {{session_id}};",
  },
  mssql: { supported: true, content: "KILL {{session_id:int}};" },
  vertica: {
    supported: true,
    content: "SELECT CLOSE_SESSION({{session_id}}) AS closed;",
  },
  clickhouse: {
    supported: true,
    content: "KILL QUERY WHERE query_id = {{session_id}};",
  },
  snowflake: {
    supported: true,
    content: "SELECT SYSTEM$CANCEL_QUERY({{session_id}}) AS cancelled;",
  },
  trino: {
    supported: true,
    content: "CALL system.runtime.kill_query(query_id => {{session_id}});",
  },
  bigquery: {
    supported: true,
    content: "CALL BQ.JOBS.CANCEL({{session_id}});",
  },
  oracle: {
    supported: true,
    content: "ALTER SYSTEM KILL SESSION '{{session_sid:int}},{{session_serial:int}}';",
  },
  redis: { supported: true, content: "CLIENT KILL ID {{session_id:int}}" },
  mongodb: { supported: true, content: "db.killOp({{session_id:int}})" },
  cassandra: {
    supported: false,
    content: "",
    reason: "Cassandra has no CQL-level session or query kill primitive.",
  },
  spanner: {
    supported: false,
    content: "",
    reason:
      "Spanner cannot cancel another session's query via SQL; cancellation happens client-side or through the Operations API.",
  },
  elasticsearch: {
    supported: false,
    content: "",
    reason:
      "Elasticsearch task cancellation is a REST call (POST /_tasks/<id>/_cancel), not a statement the query surface can run.",
  },
  opensearch: {
    supported: false,
    content: "",
    reason:
      "OpenSearch task cancellation is a REST call (POST /_tasks/<id>/_cancel), not a statement the query surface can run.",
  },
  dynamodb: {
    supported: false,
    content: "",
    reason: "DynamoDB exposes no session or query kill primitive.",
  },
  typesense: {
    supported: false,
    content: "",
    reason: "Typesense has no session or statement kill primitive the query surface can run.",
  },
  surrealdb: {
    supported: false,
    content: "",
    reason:
      "SurrealDB exposes no KILL primitive over the HTTP /rpc endpoint; cancellation is client-side only.",
  },
  weaviate: {
    supported: false,
    content: "",
    reason: "Weaviate has no session or query kill primitive.",
  },
};

// ---------------------------------------------------------------------------
// Read-only observation presets. These ship one curated SELECT per engine —
// "what DBeaver opens in its admin tabs" — and every engine without a real
// primitive gets an explicit reason instead of a canned guess.
/** Server identity + uptime surface ("Server info" in DBeaver). */
const SERVER_INFO_PRESETS: Partial<Record<DatabaseType, AdminQueryPreset>> = {
  mysql: {
    supported: true,
    content:
      "SELECT VERSION() AS server_version, @@hostname AS hostname, @@datadir AS data_directory, @@GLOBAL.uptime AS uptime_seconds;",
  },
  mariadb: {
    supported: true,
    content:
      "SELECT VERSION() AS server_version, @@hostname AS hostname, @@datadir AS data_directory, @@GLOBAL.uptime AS uptime_seconds;",
  },
  postgresql: {
    supported: true,
    content:
      "SELECT version() AS server_version, current_setting('data_directory', true) AS data_directory, pg_postmaster_start_time() AS started_at;",
  },
  greenplum: {
    supported: true,
    content:
      "SELECT version() AS server_version, current_setting('data_directory', true) AS data_directory, pg_postmaster_start_time() AS started_at;",
  },
  redshift: { supported: true, content: "SELECT version() AS server_version;" },
  cockroachdb: { supported: true, content: "SELECT * FROM crdb_internal.node_build_info;" },
  mssql: {
    supported: true,
    content:
      "SELECT @@VERSION AS server_version, SERVERPROPERTY('Edition') AS edition, SERVERPROPERTY('MachineName') AS machine;",
  },
  sqlite: { supported: true, content: "SELECT sqlite_version() AS server_version;" },
  duckdb: { supported: true, content: "SELECT version() AS server_version;" },
  libsql: { supported: true, content: "SELECT sqlite_version() AS server_version;" },
  cloudflare_d1: { supported: true, content: "SELECT sqlite_version() AS server_version;" },
  redis: { supported: true, content: "INFO server" },
  mongodb: { supported: true, content: "db.serverBuildInfo()" },
  cassandra: {
    supported: true,
    content: "SELECT cluster_name, release_version, cql_version FROM system.local;",
  },
  vertica: { supported: true, content: "SELECT version() AS server_version;" },
  clickhouse: {
    supported: true,
    content:
      "SELECT version() AS server_version, uptime() AS uptime_seconds, hostName() AS hostname;",
  },
  snowflake: {
    supported: true,
    content:
      "SELECT CURRENT_VERSION() AS server_version, CURRENT_ACCOUNT_NAME() AS account, CURRENT_ROLE() AS role, CURRENT_WAREHOUSE() AS warehouse;",
  },
  trino: {
    supported: true,
    content:
      "SELECT node_version AS server_version, node_id, coordinator, state FROM system.runtime.nodes;",
  },
  oracle: { supported: true, content: "SELECT banner AS server_version FROM v$version;" },
  spanner: {
    supported: false,
    content: "",
    reason: "Spanner is serverless — there is no single server process to interrogate.",
  },
  bigquery: {
    supported: false,
    content: "",
    reason: "BigQuery is serverless — there is no single server process to interrogate.",
  },
  dynamodb: {
    supported: false,
    content: "",
    reason: "DynamoDB is serverless — there is no single server process to interrogate.",
  },
  opensearch: { supported: true, content: "GET /" },
  elasticsearch: { supported: true, content: "GET /" },
  typesense: {
    supported: false,
    content: "",
    reason:
      "Typesense health/metrics live on the REST /health and /metrics endpoints, which the query surface cannot run.",
  },
  surrealdb: {
    supported: false,
    content: "",
    reason:
      "SurrealDB exposes no build/version statement; INFO statements return schema structure, not server identity.",
  },
  weaviate: {
    supported: false,
    content: "",
    reason: "Weaviate node info lives on the REST /v1/meta endpoint, not the query surface.",
  },
};

/** Lock/contention surface ("Locks" in DBeaver's admin tools). */
const LOCKS_PRESETS: Partial<Record<DatabaseType, AdminQueryPreset>> = {
  mysql: {
    supported: true,
    content:
      "SELECT waiting_trx_id, waiting_pid, blocking_trx_id, blocking_pid\nFROM information_schema.innodb_lock_waits;",
  },
  mariadb: {
    supported: true,
    content:
      "SELECT waiting_trx_id, waiting_pid, blocking_trx_id, blocking_pid\nFROM information_schema.innodb_lock_waits;",
  },
  postgresql: {
    supported: true,
    content:
      "SELECT l.pid, l.locktype, l.mode, l.granted, a.usename AS user_name, LEFT(a.query, 4000) AS query_text\nFROM pg_locks l\nLEFT JOIN pg_stat_activity a ON a.pid = l.pid\nWHERE NOT l.granted OR l.locktype = 'tuple'\nORDER BY l.pid;",
  },
  greenplum: {
    supported: true,
    content:
      "SELECT l.pid, l.locktype, l.mode, l.granted, a.usename AS user_name, LEFT(a.query, 4000) AS query_text\nFROM pg_locks l\nLEFT JOIN pg_stat_activity a ON a.pid = l.pid\nWHERE NOT l.granted OR l.locktype = 'tuple'\nORDER BY l.pid;",
  },
  redshift: {
    supported: true,
    content:
      "SELECT l.pid, l.locktype, l.mode, l.granted, a.user_name, LEFT(a.query, 4000) AS query_text\nFROM pg_locks l\nLEFT JOIN pg_stat_activity a ON a.pid = l.pid\nWHERE NOT l.granted\nORDER BY l.pid;",
  },
  cockroachdb: {
    supported: true,
    content: "SELECT * FROM crdb_internal.cluster_locks LIMIT 200;",
  },
  mssql: {
    supported: true,
    content:
      "SELECT session_id, blocking_session_id, wait_type, wait_time\nFROM sys.dm_exec_requests\nWHERE blocking_session_id <> 0;",
  },
  vertica: {
    supported: true,
    content:
      "SELECT node_name, object_name, lock_mode, lock_scope, request_timestamp, grant_timestamp\nFROM v_monitor.locks\nORDER BY grant_timestamp DESC\nLIMIT 200;",
  },
  snowflake: {
    supported: true,
    content:
      "SELECT * FROM TABLE(INFORMATION_SCHEMA.LOCK_WAIT_HISTORY())\nORDER BY BLOCKER_QUERY_ID\nLIMIT 200;",
  },
  oracle: {
    supported: true,
    content:
      "SELECT s.sid, s.serial#, l.type, l.lmode, l.request, o.object_name\nFROM v$lock l\nLEFT JOIN dba_objects o ON o.object_id = l.id1\nLEFT JOIN v$session s ON s.sid = l.sid\nWHERE l.block = 1 OR l.request > 0;",
  },
  spanner: {
    supported: true,
    content:
      "SELECT * FROM SPANNER_SYS.LOCK_STATS_TOP_MINUTE\nORDER BY LOCK_WAIT_SECONDS DESC\nLIMIT 50;",
  },
  mongodb: {
    supported: true,
    content: "db.adminCommand({ currentOp: true, waitingForLock: true })",
  },
  cassandra: {
    supported: false,
    content: "",
    reason: "Cassandra does not expose lock state through CQL.",
  },
  clickhouse: {
    supported: false,
    content: "",
    reason: "ClickHouse has no catalog view for lock or queue state.",
  },
  redis: {
    supported: false,
    content: "",
    reason: "Redis is single-threaded and exposes no lock surface.",
  },
  trino: {
    supported: false,
    content: "",
    reason: "Trino lock state is connector-specific; there is no uniform catalog view.",
  },
  bigquery: {
    supported: false,
    content: "",
    reason: "BigQuery has no user-visible lock surface.",
  },
  dynamodb: {
    supported: false,
    content: "",
    reason: "DynamoDB exposes no lock surface.",
  },
  opensearch: {
    supported: false,
    content: "",
    reason: "OpenSearch is lock-free; contention surfaces only as rejected write requests.",
  },
  elasticsearch: {
    supported: false,
    content: "",
    reason: "Elasticsearch is lock-free; contention surfaces only as rejected write requests.",
  },
  typesense: {
    supported: false,
    content: "",
    reason: "Typesense exposes no lock surface.",
  },
  surrealdb: {
    supported: false,
    content: "",
    reason: "SurrealDB reports no lock catalog — contention shows up only as transaction retries.",
  },
  weaviate: {
    supported: false,
    content: "",
    reason: "Weaviate exposes no lock surface.",
  },
};

/** Per-table size/row surface ("Table properties" in DBeaver). */
const TABLE_STATS_PRESETS: Partial<Record<DatabaseType, AdminQueryPreset>> = {
  mysql: {
    supported: true,
    content:
      "SELECT table_schema, table_name, table_rows AS approx_rows, ROUND((data_length + index_length) / 1048576, 1) AS size_mb\nFROM information_schema.tables\nWHERE table_schema = DATABASE()\nORDER BY data_length + index_length DESC\nLIMIT 100;",
  },
  mariadb: {
    supported: true,
    content:
      "SELECT table_schema, table_name, table_rows AS approx_rows, ROUND((data_length + index_length) / 1048576, 1) AS size_mb\nFROM information_schema.tables\nWHERE table_schema = DATABASE()\nORDER BY data_length + index_length DESC\nLIMIT 100;",
  },
  postgresql: {
    supported: true,
    content:
      "SELECT schemaname AS schema_name, relname AS table_name, n_live_tup AS live_rows, pg_size_pretty(pg_total_relation_size(relid)) AS total_size\nFROM pg_stat_user_tables\nORDER BY pg_total_relation_size(relid) DESC\nLIMIT 100;",
  },
  greenplum: {
    supported: true,
    content:
      "SELECT schemaname AS schema_name, relname AS table_name, n_live_tup AS live_rows, pg_size_pretty(pg_total_relation_size(relid)) AS total_size\nFROM pg_stat_user_tables\nORDER BY pg_total_relation_size(relid) DESC\nLIMIT 100;",
  },
  redshift: {
    supported: true,
    content:
      'SELECT "schema", "table", size AS size_mb, estimated_visible_rows\nFROM svv_table_info\nORDER BY size DESC\nLIMIT 100;',
  },
  cockroachdb: {
    supported: true,
    content:
      "SELECT table_name, MAX(approximate_row_count) AS approx_rows\nFROM crdb_internal.table_row_statistics\nGROUP BY table_name\nORDER BY approx_rows DESC;",
  },
  mssql: {
    supported: true,
    content:
      "SELECT s.name AS schema_name, t.name AS table_name, SUM(p.rows) AS row_count, ROUND(SUM(a.total_pages) * 8.0 / 1024, 1) AS size_mb\nFROM sys.tables t\nJOIN sys.schemas s ON s.schema_id = t.schema_id\nJOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)\nJOIN sys.allocation_units a ON a.container_id = p.partition_id\nGROUP BY s.name, t.name\nORDER BY SUM(a.total_pages) DESC;",
  },
  sqlite: {
    supported: true,
    content:
      "SELECT name AS table_name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
  },
  duckdb: {
    supported: true,
    content:
      "SELECT schema_name, table_name, estimated_size AS approx_rows, column_count, temporary AS is_temporary\nFROM duckdb_tables()\nORDER BY estimated_size DESC;",
  },
  libsql: {
    supported: true,
    content:
      "SELECT name AS table_name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
  },
  cloudflare_d1: {
    supported: true,
    content:
      "SELECT name AS table_name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
  },
  oracle: {
    supported: true,
    content:
      "SELECT * FROM (SELECT owner, segment_name AS table_name, ROUND(SUM(bytes) / 1048576, 1) AS size_mb\nFROM dba_segments\nWHERE segment_type = 'TABLE'\nGROUP BY owner, segment_name\nORDER BY SUM(bytes) DESC) WHERE ROWNUM <= 100;",
  },
  cassandra: {
    supported: true,
    content:
      "SELECT keyspace_name, table_name, SUM(partitions_count) AS partitions, ROUND(SUM(mean_partition_size) / 1024, 0) AS mean_partition_kb\nFROM system.size_estimates\nGROUP BY keyspace_name, table_name;",
  },
  vertica: {
    supported: true,
    content:
      "SELECT anchor_table_schema AS schema_name, anchor_table_name AS table_name, ROUND(SUM(used_bytes) / 1048576, 1) AS size_mb, SUM(row_count) AS row_count\nFROM v_monitor.column_storage\nGROUP BY anchor_table_schema, anchor_table_name\nORDER BY SUM(used_bytes) DESC\nLIMIT 100;",
  },
  clickhouse: {
    supported: true,
    content:
      "SELECT database, name AS table_name, formatReadableSize(SUM(bytes_on_disk)) AS size, SUM(rows) AS rows\nFROM system.parts\nWHERE active\nGROUP BY database, name\nORDER BY SUM(bytes_on_disk) DESC\nLIMIT 100;",
  },
  snowflake: {
    supported: true,
    content:
      "SELECT table_schema, table_name, row_count, ROUND(bytes / 1048576, 1) AS size_mb\nFROM information_schema.tables\nORDER BY bytes DESC NULLS LAST\nLIMIT 100;",
  },
  surrealdb: { supported: true, content: "INFO FOR DB;" },
  opensearch: {
    supported: true,
    content: "GET /_cat/indices?format=json&s=store.size:desc",
  },
  elasticsearch: {
    supported: true,
    content: "GET /_cat/indices?format=json&s=store.size:desc",
  },
  trino: {
    supported: false,
    content: "",
    reason: "Trino table statistics are connector-dependent; there is no uniform catalog surface.",
  },
  bigquery: {
    supported: false,
    content: "",
    reason:
      "BigQuery table statistics are dataset-scoped (INFORMATION_SCHEMA.TABLE_STORAGE); the preset surface cannot reach an arbitrary dataset — use the schema browser instead.",
  },
  spanner: {
    supported: false,
    content: "",
    reason: "Spanner exposes no row-count or size statistics through the SQL surface.",
  },
  dynamodb: {
    supported: false,
    content: "",
    reason: "DynamoDB table sizes live in CloudWatch/DescribeTable, not in a query surface.",
  },
  mongodb: {
    supported: false,
    content: "",
    reason:
      "MongoDB collection statistics are per-collection commands; there is no cluster-wide stats preset.",
  },
  redis: {
    supported: false,
    content: "",
    reason: "Redis tracks memory per keyspace, not per table; use INFO memory instead.",
  },
  typesense: {
    supported: false,
    content: "",
    reason:
      "Typesense collection stats live on the REST /collections endpoint the query surface cannot run.",
  },
  weaviate: {
    supported: false,
    content: "",
    reason:
      "Weaviate class statistics live on the REST /v1/schema endpoint the query surface cannot run.",
  },
};

/** Index hit-miss surface — "which indexes are actually used". */
const INDEX_USAGE_PRESETS: Partial<Record<DatabaseType, AdminQueryPreset>> = {
  mysql: {
    supported: true,
    // Unused indexes sort first — that is the actionable half of the list.
    content:
      "SELECT object_schema AS schema_name, object_name AS table_name, index_name, count_read AS reads\nFROM performance_schema.table_io_waits_summary_by_index_usage\nWHERE index_name IS NOT NULL AND object_schema NOT IN ('mysql','sys','performance_schema','information_schema')\nORDER BY count_read ASC\nLIMIT 200;",
  },
  mariadb: {
    supported: true,
    content:
      "SELECT object_schema AS schema_name, object_name AS table_name, index_name, count_read AS reads\nFROM performance_schema.table_io_waits_summary_by_index_usage\nWHERE index_name IS NOT NULL AND object_schema NOT IN ('mysql','sys','performance_schema','information_schema')\nORDER BY count_read ASC\nLIMIT 200;",
  },
  postgresql: {
    supported: true,
    content:
      "SELECT schemaname AS schema_name, relname AS table_name, indexrelname AS index_name, idx_scan AS scans, pg_size_pretty(pg_relation_size(indexrelid)) AS index_size\nFROM pg_stat_user_indexes\nORDER BY idx_scan ASC\nLIMIT 200;",
  },
  greenplum: {
    supported: true,
    content:
      "SELECT schemaname AS schema_name, relname AS table_name, indexrelname AS index_name, idx_scan AS scans, pg_size_pretty(pg_relation_size(indexrelid)) AS index_size\nFROM pg_stat_user_indexes\nORDER BY idx_scan ASC\nLIMIT 200;",
  },
  cockroachdb: {
    supported: true,
    content:
      "SELECT table_name, index_name, total_reads, total_rows_read, last_read\nFROM crdb_internal.index_usage_statistics\nORDER BY total_reads ASC\nLIMIT 200;",
  },
  mssql: {
    supported: true,
    content:
      "SELECT OBJECT_NAME(i.object_id) AS table_name, i.name AS index_name, ISNULL(s.user_seeks, 0) + ISNULL(s.user_scans, 0) + ISNULL(s.user_lookups, 0) AS uses\nFROM sys.indexes i\nLEFT JOIN sys.dm_db_index_usage_stats s ON s.object_id = i.object_id AND s.index_id = i.index_id AND s.database_id = DB_ID()\nWHERE i.type > 0\nORDER BY uses ASC;",
  },
  oracle: {
    supported: false,
    content: "",
    reason:
      "Oracle usage tracking (v$object_usage) is deprecated in 12c+; no query-level view exists.",
  },
  vertica: {
    supported: false,
    content: "",
    reason: "Vertica has no secondary indexes — projections are the physical layout.",
  },
  redshift: {
    supported: false,
    content: "",
    reason: "Redshift has no indexes to track — distribution and sort keys serve that role.",
  },
  snowflake: {
    supported: false,
    content: "",
    reason: "Snowflake is index-free; clustering metadata lives on the table.",
  },
  trino: {
    supported: false,
    content: "",
    reason: "Trino exposes no index catalog.",
  },
  cassandra: {
    supported: false,
    content: "",
    reason: "Cassandra has no per-index usage statistics.",
  },
  clickhouse: {
    supported: false,
    content: "",
    reason: "ClickHouse data-skipping indexes are physical; there is no usage counter.",
  },
  mongodb: {
    supported: false,
    content: "",
    reason:
      "MongoDB index stats are a per-collection aggregation; there is no cluster-wide preset.",
  },
  redis: {
    supported: false,
    content: "",
    reason: "Redis is key-based; there is no index surface.",
  },
  bigquery: {
    supported: false,
    content: "",
    reason: "BigQuery is index-free — columnar storage handles filtering implicitly.",
  },
  spanner: {
    supported: false,
    content: "",
    reason: "Spanner has no per-index usage counters in the SQL surface.",
  },
  dynamodb: {
    supported: false,
    content: "",
    reason: "DynamoDB indexes are physical GSIs; usage lives in CloudWatch metrics.",
  },
  opensearch: {
    supported: false,
    content: "",
    reason:
      "OpenSearch index statistics are REST _stats calls, not statements the query surface runs.",
  },
  elasticsearch: {
    supported: false,
    content: "",
    reason:
      "Elasticsearch index statistics are REST _stats calls, not statements the query surface runs.",
  },
  typesense: {
    supported: false,
    content: "",
    reason: "Typesense is schema-indexed by definition; there is no usage surface.",
  },
  surrealdb: {
    supported: false,
    content: "",
    reason: "SurrealDB exposes no index usage statistics.",
  },
  weaviate: {
    supported: false,
    content: "",
    reason: "Weaviate is vector-indexed; there is no usage surface.",
  },
};

/** Long-running / heaviest-statement surface ("Session manager" in DBeaver). */
const SLOW_QUERY_PRESETS: Partial<Record<DatabaseType, AdminQueryPreset>> = {
  mysql: {
    supported: true,
    content:
      "SELECT id, user, host, db, time AS seconds_running, LEFT(info, 4000) AS query_text\nFROM information_schema.processlist\nWHERE command = 'Query' AND time > 5\nORDER BY time DESC;",
  },
  mariadb: {
    supported: true,
    content:
      "SELECT id, user, host, db, time AS seconds_running, LEFT(info, 4000) AS query_text\nFROM information_schema.processlist\nWHERE command = 'Query' AND time > 5\nORDER BY time DESC;",
  },
  postgresql: {
    supported: true,
    content:
      "SELECT pid, usename AS user_name, datname AS database_name, now() - query_start AS duration, LEFT(query, 4000) AS query_text\nFROM pg_stat_activity\nWHERE state = 'active' AND query_start < now() - interval '5 seconds' AND pid <> pg_backend_pid()\nORDER BY duration DESC;",
  },
  greenplum: {
    supported: true,
    content:
      "SELECT pid, usename AS user_name, datname AS database_name, now() - query_start AS duration, LEFT(query, 4000) AS query_text\nFROM pg_stat_activity\nWHERE state = 'active' AND query_start < now() - interval '5 seconds' AND pid <> pg_backend_pid()\nORDER BY duration DESC;",
  },
  redshift: {
    supported: true,
    content:
      "SELECT userid, query AS query_id, LEFT(text, 4000) AS query_text, starttime\nFROM stv_inflight\nORDER BY starttime;",
  },
  cockroachdb: {
    supported: true,
    content: "SELECT * FROM crdb_internal.cluster_queries ORDER BY start DESC LIMIT 50;",
  },
  mssql: {
    supported: true,
    content:
      "SELECT TOP 50 qs.execution_count, qs.total_worker_time / qs.execution_count AS avg_cpu_us, qs.total_elapsed_time / qs.execution_count AS avg_elapsed_us, LEFT(t.text, 4000) AS query_text\nFROM sys.dm_exec_query_stats qs\nCROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) t\nORDER BY qs.total_elapsed_time DESC;",
  },
  vertica: {
    supported: true,
    content:
      "SELECT request_id, transaction_id, statement_id, user_name, request, request_duration_ms\nFROM v_monitor.query_requests\nWHERE is_executing\nORDER BY request_duration_ms DESC\nLIMIT 50;",
  },
  clickhouse: {
    supported: true,
    content:
      "SELECT query_id, user, query_duration_ms, read_rows, LEFT(query, 4000) AS query_text\nFROM system.query_log\nWHERE type = 'QueryFinish' AND query_duration_ms > 1000\nORDER BY event_time DESC\nLIMIT 50;",
  },
  snowflake: {
    supported: true,
    content:
      "SELECT query_id, user_name, execution_status, total_elapsed_time, query_text\nFROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY(RESULT_LIMIT => 50))\nORDER BY total_elapsed_time DESC;",
  },
  trino: {
    supported: true,
    content:
      "SELECT query_id, user, state, elapsed_time, query\nFROM system.runtime.queries\nORDER BY elapsed_time DESC\nLIMIT 50;",
  },
  bigquery: {
    supported: true,
    content:
      "SELECT job_id, user_email, state, TIMESTAMP_DIFF(end_time, start_time, SECOND) AS duration_seconds, LEFT(query, 4000) AS query_text\nFROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT\nWHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR) AND state = 'DONE'\nORDER BY duration_seconds DESC\nLIMIT 50;",
  },
  spanner: {
    supported: true,
    content:
      "SELECT INTERVAL_END, TEXT_FINGERPRINT, EXECUTION_COUNT, AVG_LATENCY_SECONDS\nFROM SPANNER_SYS.QUERY_STATS_TOP_10MINUTE\nORDER BY AVG_LATENCY_SECONDS DESC\nLIMIT 50;",
  },
  oracle: {
    supported: true,
    content:
      "SELECT * FROM (SELECT sql_id, executions, ROUND(elapsed_time / 1e6 / GREATEST(executions, 1), 3) AS avg_seconds, SUBSTR(sql_text, 1, 4000) AS query_text\nFROM v$sql\nORDER BY elapsed_time / GREATEST(executions, 1) DESC) WHERE ROWNUM <= 50;",
  },
  cassandra: {
    supported: true,
    content: "SELECT * FROM system_traces.sessions LIMIT 50;",
  },
  mongodb: {
    supported: false,
    content: "",
    reason:
      "MongoDB's profiler (db.system.profile) is per-database and off by default — there is no cluster-wide slow-query preset.",
  },
  redis: { supported: true, content: "SLOWLOG GET 50" },
  dynamodb: {
    supported: false,
    content: "",
    reason: "DynamoDB latency lives in CloudWatch metrics, not a query surface.",
  },
  opensearch: {
    supported: false,
    content: "",
    reason: "OpenSearch slow logs are file-based or per-index settings — no live query surface.",
  },
  elasticsearch: {
    supported: false,
    content: "",
    reason: "Elasticsearch slow logs are file-based or per-index settings — no live query surface.",
  },
  typesense: {
    supported: false,
    content: "",
    reason: "Typesense surfaces no slow-query catalog.",
  },
  surrealdb: {
    supported: false,
    content: "",
    reason: "SurrealDB surfaces no slow-query catalog over the query endpoint.",
  },
  weaviate: {
    supported: false,
    content: "",
    reason: "Weaviate surfaces no slow-query catalog.",
  },
};

/**
 * Menu label for the kill-session action. Kept beside the presets rather than
 * the global i18n table — the label only exists where these presets surface.
 */
export function killSessionMenuLabel(language: string): string {
  switch (language) {
    case "vi":
      return "Kết thúc phiên...";
    case "zh":
      return "终止会话...";
    case "tr":
      return "Oturumu sonlandır...";
    case "ko":
      return "세션 종료...";
    default:
      return "Kill session...";
  }
}

/**
 * Menu label for the new admin presets. Same pattern as
 * `killSessionMenuLabel` — the label lives beside the presets, not in the
 * global i18n table.
 */
export function adminQueryMenuLabel(language: string, kind: AdminQueryKind): string {
  const en =
    kind === "server-info"
      ? "Server info..."
      : kind === "locks"
        ? "Locks..."
        : kind === "table-stats"
          ? "Table statistics..."
          : kind === "index-usage"
            ? "Index usage..."
            : kind === "slow-queries"
              ? "Slow queries..."
              : kind === "kill-session"
                ? "Kill session..."
                : kind === "process-list"
                  ? "Process list..."
                  : "User management...";
  const vi =
    kind === "server-info"
      ? "Thông tin máy chủ..."
      : kind === "locks"
        ? "Khoá đang giữ..."
        : kind === "table-stats"
          ? "Thống kê bảng..."
          : kind === "index-usage"
            ? "Mức dùng index..."
            : kind === "slow-queries"
              ? "Truy vấn chậm..."
              : kind === "kill-session"
                ? "Kết thúc phiên..."
                : kind === "process-list"
                  ? "Danh sách tiến trình..."
                  : "Quản lý người dùng...";
  const zh =
    kind === "server-info"
      ? "服务器信息..."
      : kind === "locks"
        ? "锁信息..."
        : kind === "table-stats"
          ? "表统计信息..."
          : kind === "index-usage"
            ? "索引使用情况..."
            : kind === "slow-queries"
              ? "慢查询..."
              : kind === "kill-session"
                ? "终止会话..."
                : kind === "process-list"
                  ? "进程列表..."
                  : "用户管理...";
  const tr =
    kind === "server-info"
      ? "Sunucu bilgisi..."
      : kind === "locks"
        ? "Kilitler..."
        : kind === "table-stats"
          ? "Tablo istatistikleri..."
          : kind === "index-usage"
            ? "Dizin kullanımı..."
            : kind === "slow-queries"
              ? "Yavaş sorgular..."
              : kind === "kill-session"
                ? "Oturumu sonlandır..."
                : kind === "process-list"
                  ? "Islem listesi..."
                  : "Kullanici yonetimi...";
  const ko =
    kind === "server-info"
      ? "서버 정보..."
      : kind === "locks"
        ? "잠금..."
        : kind === "table-stats"
          ? "테이블 통계..."
          : kind === "index-usage"
            ? "인덱스 사용량..."
            : kind === "slow-queries"
              ? "느린 쿼리..."
              : kind === "kill-session"
                ? "세션 종료..."
                : kind === "process-list"
                  ? "프로세스 목록..."
                  : "사용자 관리...";
  switch (language) {
    case "vi":
      return vi;
    case "zh":
      return zh;
    case "tr":
      return tr;
    case "ko":
      return ko;
    default:
      return en;
  }
}

export function getAdminQueryPreset(
  dbType: DatabaseType | undefined,
  kind: AdminQueryKind,
): AdminQueryPreset {
  if (!dbType) {
    return unsupported("No active connection.");
  }

  const embedded =
    dbType === "sqlite" || dbType === "duckdb" || dbType === "libsql" || dbType === "cloudflare_d1";

  switch (kind) {
    case "process-list":
      if (embedded) {
        return unsupported("This engine does not expose a live server process list.");
      }
      return (
        PROCESS_LIST_PRESETS[dbType] ??
        unsupported("No process list preset is available for this engine yet.")
      );
    case "kill-session":
      if (embedded) {
        return unsupported("This engine has no server-side sessions to kill.");
      }
      return (
        KILL_SESSION_PRESETS[dbType] ??
        unsupported("No kill-session preset is available for this engine yet.")
      );
    case "user-management":
      if (embedded) {
        return unsupported(
          "This engine does not have server-managed users in the current workspace model.",
        );
      }
      return (
        USER_MANAGEMENT_PRESETS[dbType] ??
        unsupported("No user management preset is available for this engine yet.")
      );
    case "locks":
      if (embedded) {
        return unsupported("This engine has no server-side lock catalog.");
      }
      return (
        LOCKS_PRESETS[dbType] ?? unsupported("No lock preset is available for this engine yet.")
      );
    case "server-info":
      return (
        SERVER_INFO_PRESETS[dbType] ??
        unsupported("No server info preset is available for this engine yet.")
      );
    case "table-stats":
      return (
        TABLE_STATS_PRESETS[dbType] ??
        unsupported("No table statistics preset is available for this engine yet.")
      );
    case "index-usage":
      if (embedded) {
        return unsupported("This engine keeps no per-index usage counters.");
      }
      return (
        INDEX_USAGE_PRESETS[dbType] ??
        unsupported("No index usage preset is available for this engine yet.")
      );
    case "slow-queries":
      if (embedded) {
        return unsupported("This engine has no server-side query catalog.");
      }
      return (
        SLOW_QUERY_PRESETS[dbType] ??
        unsupported("No slow query preset is available for this engine yet.")
      );
  }
}
