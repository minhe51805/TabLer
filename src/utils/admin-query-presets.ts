import type { DatabaseType } from "../types";

export type AdminQueryKind = "process-list" | "user-management";

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
  cockroachdb: { supported: true, content: "SHOW CLUSTER SESSIONS;" },
  mssql: { supported: true, content: "EXEC sp_who2;" },
  redis: { supported: true, content: "CLIENT LIST" },
  mongodb: { supported: true, content: 'db.adminCommand({ currentOp: true, $all: true })' },
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
  cockroachdb: { supported: true, content: "SHOW ROLES;" },
  mssql: {
    supported: true,
    content:
      "SELECT name, type_desc, create_date, modify_date\nFROM sys.database_principals\nWHERE principal_id > 4\nORDER BY name;",
  },
  redis: { supported: true, content: "ACL LIST" },
  mongodb: { supported: true, content: 'db.getSiblingDB("admin").runCommand({ usersInfo: 1 })' },
  cassandra: { supported: true, content: "LIST ROLES;" },
  vertica: {
    supported: true,
    content:
      "SELECT user_name, is_super_user, locked\nFROM users\nORDER BY user_name;",
  },
  clickhouse: {
    supported: true,
    content:
      "SELECT name, storage, auth_type\nFROM system.users\nORDER BY name;",
  },
  snowflake: { supported: true, content: "SHOW USERS;" },
};

export function getAdminQueryPreset(
  dbType: DatabaseType | undefined,
  kind: AdminQueryKind,
): AdminQueryPreset {
  if (!dbType) {
    return unsupported("No active connection.");
  }

  if (kind === "process-list") {
    if (dbType === "sqlite" || dbType === "duckdb" || dbType === "libsql" || dbType === "cloudflare_d1") {
      return unsupported("This engine does not expose a live server process list.");
    }

    if (dbType === "bigquery") {
      return unsupported("BigQuery process inspection depends on region-scoped INFORMATION_SCHEMA views.");
    }

    return PROCESS_LIST_PRESETS[dbType] ?? unsupported("No process list preset is available for this engine yet.");
  }

  if (dbType === "sqlite" || dbType === "duckdb" || dbType === "libsql" || dbType === "cloudflare_d1") {
    return unsupported("This engine does not have server-managed users in the current workspace model.");
  }

  if (dbType === "bigquery") {
    return unsupported("BigQuery access is governed by IAM rather than an in-database user list.");
  }

  return USER_MANAGEMENT_PRESETS[dbType] ?? unsupported("No user management preset is available for this engine yet.");
}
