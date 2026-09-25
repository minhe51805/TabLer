import type { DatabaseType } from "../types";

export type AdminQueryKind = "process-list" | "user-management" | "kill-session";

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

export function getAdminQueryPreset(
  dbType: DatabaseType | undefined,
  kind: AdminQueryKind,
): AdminQueryPreset {
  if (!dbType) {
    return unsupported("No active connection.");
  }

  if (kind === "process-list") {
    if (
      dbType === "sqlite" ||
      dbType === "duckdb" ||
      dbType === "libsql" ||
      dbType === "cloudflare_d1"
    ) {
      return unsupported("This engine does not expose a live server process list.");
    }

    return (
      PROCESS_LIST_PRESETS[dbType] ??
      unsupported("No process list preset is available for this engine yet.")
    );
  }

  if (kind === "kill-session") {
    if (
      dbType === "sqlite" ||
      dbType === "duckdb" ||
      dbType === "libsql" ||
      dbType === "cloudflare_d1"
    ) {
      return unsupported("This engine has no server-side sessions to kill.");
    }

    return (
      KILL_SESSION_PRESETS[dbType] ??
      unsupported("No kill-session preset is available for this engine yet.")
    );
  }

  if (
    dbType === "sqlite" ||
    dbType === "duckdb" ||
    dbType === "libsql" ||
    dbType === "cloudflare_d1"
  ) {
    return unsupported(
      "This engine does not have server-managed users in the current workspace model.",
    );
  }

  return (
    USER_MANAGEMENT_PRESETS[dbType] ??
    unsupported("No user management preset is available for this engine yet.")
  );
}
