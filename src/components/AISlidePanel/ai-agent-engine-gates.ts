import type { DatabaseType, QueryModel } from "../../types";
import type { AIAgentToolName } from "./ai-agent-tool-schema";

/**
 * Query language of each engine, mirrored from
 * `driver_capabilities().query_model` in capabilities.rs. Kept here so the
 * agent can gate tools from `db_type` without waiting on the capability IPC.
 */
export const AGENT_QUERY_MODEL_BY_ENGINE: Record<DatabaseType, QueryModel> = {
  mysql: "sql",
  mariadb: "sql",
  sqlite: "sql",
  duckdb: "sql",
  cockroachdb: "sql",
  snowflake: "sql",
  postgresql: "sql",
  greenplum: "sql",
  redshift: "sql",
  mssql: "sql",
  vertica: "sql",
  clickhouse: "sql",
  bigquery: "sql",
  libsql: "sql",
  cloudflare_d1: "sql",
  cassandra: "cql",
  redis: "kv",
  mongodb: "document",
  opensearch: "search",
};

const ENGINE_LABEL: Record<DatabaseType, string> = {
  mysql: "MySQL",
  mariadb: "MariaDB",
  sqlite: "SQLite",
  duckdb: "DuckDB",
  cockroachdb: "CockroachDB",
  snowflake: "Snowflake",
  postgresql: "PostgreSQL",
  greenplum: "Greenplum",
  redshift: "Amazon Redshift",
  mssql: "SQL Server",
  vertica: "Vertica",
  clickhouse: "ClickHouse",
  bigquery: "Google BigQuery",
  libsql: "LibSQL",
  cloudflare_d1: "Cloudflare D1",
  cassandra: "Apache Cassandra",
  redis: "Redis",
  mongodb: "MongoDB",
  opensearch: "OpenSearch",
};

export interface AgentToolAvailability {
  queryModel: QueryModel;
  engineKey: string | null;
  engineLabel: string;
  sqlRead: boolean;
  sqlWritePreview: boolean;
}

export function agentQueryModelForEngine(engineKey: string | null | undefined): QueryModel {
  if (engineKey && engineKey in AGENT_QUERY_MODEL_BY_ENGINE) {
    return AGENT_QUERY_MODEL_BY_ENGINE[engineKey as DatabaseType];
  }
  return "sql";
}

export function agentToolAvailability(
  engineKey: string | null | undefined,
  queryModelFromProfile?: QueryModel | null,
): AgentToolAvailability {
  const queryModel = queryModelFromProfile ?? agentQueryModelForEngine(engineKey);
  const known = engineKey && engineKey in ENGINE_LABEL
    ? ENGINE_LABEL[engineKey as DatabaseType]
    : engineKey || "this engine";
  return {
    queryModel,
    engineKey: engineKey ?? null,
    engineLabel: known,
    sqlRead: queryModel === "sql" || queryModel === "cql",
    sqlWritePreview: queryModel === "sql",
  };
}

export function isAgentToolEnabled(
  name: AIAgentToolName,
  availability: Pick<AgentToolAvailability, "sqlRead" | "sqlWritePreview">,
): boolean {
  if (name === "run_readonly_sql" || name === "run_parameterized_sql") return availability.sqlRead;
  if (name === "find_value" || name === "check_sql") return availability.sqlRead;
  if (name === "list_schema_objects" || name === "run_preset") return availability.sqlRead;
  if (name === "preview_write") return availability.sqlWritePreview;
  return true;
}

export function agentSqlToolBlockedMessage(
  name: "run_readonly_sql" | "run_parameterized_sql" | "find_value" | "check_sql" | "preview_write",
  availability: AgentToolAvailability,
): string {
  if (name === "run_readonly_sql") {
    return `Tool blocked: run_readonly_sql is not available on ${availability.engineLabel}. This engine does not speak SQL. Use list_tables, describe_table, search_schema, or sample_table_data instead.`;
  }
  if (name === "run_parameterized_sql" || name === "find_value") {
    return `Tool blocked: ${name} is not available on ${availability.engineLabel}. This engine does not support parameterized SQL reads. Use list_tables, describe_table, search_schema, or sample_table_data instead.`;
  }
  return `Tool blocked: preview_write is not available on ${availability.engineLabel}. SQL write previews are only offered on SQL engines.`;
}

/** Catalog options used by native function-calling and the controller listing. */
export function nativeCatalogOptionsForEngine(engineKey?: string | null) {
  return {
    workspaceToolsEnabled: true as const,
    availability: agentToolAvailability(engineKey),
  };
}

/** Data-plane hints injected into every agent controller request. */
export function engineAwareDataPlaneHints(availability: AgentToolAvailability) {
  if (availability.sqlRead) {
    return {
      gather:
        "You are an autonomous agent that takes action, not a consultant. Decide your own steps: locate unknown fields with search_schema, inspect the exact table with describe_table, then ACTUALLY gather data yourself with sample_table_data or run_readonly_sql. Do not just suggest queries and do not ask the user which query to run first ? pick the most relevant one and run it yourself.",
      mustRead:
        "When the user asks to see data, charts, counts, samples, distributions, or 'show me' anything, you MUST run at least one sample_table_data or run_readonly_sql before finishing. Finishing with only suggestions and no executed query is a failure.",
      finishSql:
        "When you finish, put the single best runnable query in finish.args.sql (a real SELECT grounded in the verified schema) so it can be executed and shown to the user automatically.",
    };
  }
  return {
    gather: `You are an autonomous agent on ${availability.engineLabel}, which does not speak SQL. Decide your own steps: locate unknown fields with search_schema, inspect the exact table with describe_table, then ACTUALLY gather data with sample_table_data. Never call run_readonly_sql or preview_write.`,
    mustRead:
      "When the user asks to see data, charts, counts, samples, distributions, or 'show me' anything, you MUST run sample_table_data before finishing. Finishing with only suggestions and no executed query is a failure.",
    finishSql: "When you finish, omit finish.args.sql. Put the answer in finish.args.response.",
  };
}
