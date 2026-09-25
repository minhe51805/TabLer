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
  oracle: "sql",
  spanner: "sql",
  dynamodb: "sql",
  trino: "sql",
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
  oracle: "Oracle (ORDS)",
  spanner: "Google Spanner",
  dynamodb: "Amazon DynamoDB",
  trino: "Trino",
};

export interface AgentToolAvailability {
  queryModel: QueryModel;
  engineKey: string | null;
  engineLabel: string;
  /** SELECT-shaped reads work: SQL engines, CQL SELECT, and MongoDB's
   *  translated SELECT subset (mirrors agent_allows_sql_read). */
  sqlRead: boolean;
  /** Backend PreparedParameters capability — run_parameterized_sql and
   *  find_value compile :name bindings through it (capabilities.rs). */
  parameterizedRead: boolean;
  /** The driver overrides preview_write_transaction — every other engine
   *  hits the default "not supported" error (driver.rs). */
  previewWrite: boolean;
  /** The driver returns real schema objects; mongodb/redis/opensearch
   *  return an empty list, so the tool would always report zero objects. */
  schemaObjects: boolean;
  /** At least one admin preset exists AND the sandboxed transport can run
   *  it. mongodb/redis presets are shell/command syntax the SQL sandbox
   *  rejects, so they stay gated. */
  presets: boolean;
  /** propose_seed_data may emit a reviewable INSERT/insertMany script. */
  seedPropose: boolean;
  /** Checkpoint restore re-executes a SQL INSERT dump — impossible on
   *  mongodb/redis, hard-blocked on opensearch (restore.rs). */
  checkpointRestore: boolean;
  /** SQL dialect write previews exist (kept for prompt hints; the tool
   *  itself gates on previewWrite). */
  sqlWritePreview: boolean;
  /** Document engines (MongoDB): the agent may propose insertMany seed data
   *  through a query tab proposal — never executes writes itself. */
  documentPropose: boolean;
}

/**
 * Per-engine tool capability flags, mirrored from `driver_capabilities()`
 * in capabilities.rs (prepared_parameters) plus the actual driver impls
 * (preview_write_transaction, list_schema_objects, restore path). Keep in
 * lockstep with the backend matrix — a tool advertised where the driver
 * cannot run it is a guaranteed error.
 */
const AGENT_ENGINE_TOOL_FLAGS: Record<
  DatabaseType,
  Pick<
    AgentToolAvailability,
    "parameterizedRead" | "previewWrite" | "schemaObjects" | "presets" | "checkpointRestore"
  >
> = {
  mysql: {
    parameterizedRead: true,
    previewWrite: true,
    schemaObjects: true,
    presets: true,
    checkpointRestore: true,
  },
  mariadb: {
    parameterizedRead: true,
    previewWrite: true,
    schemaObjects: true,
    presets: true,
    checkpointRestore: true,
  },
  postgresql: {
    parameterizedRead: true,
    previewWrite: true,
    schemaObjects: true,
    presets: true,
    checkpointRestore: true,
  },
  cockroachdb: {
    parameterizedRead: true,
    previewWrite: true,
    schemaObjects: true,
    presets: true,
    checkpointRestore: true,
  },
  greenplum: {
    parameterizedRead: true,
    previewWrite: true,
    schemaObjects: true,
    presets: true,
    checkpointRestore: true,
  },
  redshift: {
    parameterizedRead: true,
    previewWrite: true,
    schemaObjects: true,
    presets: true,
    checkpointRestore: true,
  },
  vertica: {
    parameterizedRead: true,
    previewWrite: true,
    schemaObjects: true,
    presets: true,
    checkpointRestore: true,
  },
  mssql: {
    parameterizedRead: true,
    previewWrite: true,
    schemaObjects: true,
    presets: true,
    checkpointRestore: true,
  },
  sqlite: {
    parameterizedRead: true,
    previewWrite: true,
    schemaObjects: true,
    presets: false,
    checkpointRestore: true,
  },
  duckdb: {
    parameterizedRead: true,
    previewWrite: false,
    schemaObjects: true,
    presets: false,
    checkpointRestore: true,
  },
  cassandra: {
    parameterizedRead: false,
    previewWrite: false,
    schemaObjects: true,
    presets: true,
    checkpointRestore: true,
  },
  snowflake: {
    parameterizedRead: false,
    previewWrite: false,
    schemaObjects: true,
    presets: true,
    checkpointRestore: true,
  },
  clickhouse: {
    parameterizedRead: false,
    previewWrite: false,
    schemaObjects: true,
    presets: true,
    checkpointRestore: true,
  },
  bigquery: {
    parameterizedRead: false,
    previewWrite: false,
    schemaObjects: true,
    presets: false,
    checkpointRestore: true,
  },
  libsql: {
    parameterizedRead: false,
    previewWrite: false,
    schemaObjects: true,
    presets: false,
    checkpointRestore: true,
  },
  cloudflare_d1: {
    parameterizedRead: false,
    previewWrite: false,
    schemaObjects: true,
    presets: false,
    checkpointRestore: true,
  },
  redis: {
    parameterizedRead: false,
    previewWrite: false,
    schemaObjects: false,
    presets: false,
    checkpointRestore: false,
  },
  mongodb: {
    parameterizedRead: false,
    previewWrite: true,
    schemaObjects: false,
    presets: false,
    checkpointRestore: false,
  },
  opensearch: {
    parameterizedRead: false,
    previewWrite: false,
    schemaObjects: false,
    presets: false,
    checkpointRestore: false,
  },
  oracle: {
    parameterizedRead: false,
    previewWrite: false,
    schemaObjects: true,
    presets: false,
    checkpointRestore: true,
  },
  spanner: {
    parameterizedRead: true,
    previewWrite: true,
    schemaObjects: true,
    presets: false,
    checkpointRestore: true,
  },
  dynamodb: {
    parameterizedRead: true,
    previewWrite: false,
    schemaObjects: false,
    presets: false,
    checkpointRestore: false,
  },
  trino: {
    parameterizedRead: true,
    previewWrite: true,
    schemaObjects: true,
    presets: false,
    checkpointRestore: true,
  },
};

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
  const known =
    engineKey && engineKey in ENGINE_LABEL
      ? ENGINE_LABEL[engineKey as DatabaseType]
      : engineKey || "this engine";
  const flags =
    engineKey && engineKey in AGENT_ENGINE_TOOL_FLAGS
      ? AGENT_ENGINE_TOOL_FLAGS[engineKey as DatabaseType]
      : null;
  return {
    queryModel,
    engineKey: engineKey ?? null,
    engineLabel: known,
    sqlRead: queryModel === "sql" || queryModel === "cql" || queryModel === "document",
    // Unknown engines keep the permissive default (previous behavior); the
    // backend capability gate still refuses what the driver cannot do.
    parameterizedRead: flags?.parameterizedRead ?? true,
    previewWrite: flags?.previewWrite ?? true,
    schemaObjects: flags?.schemaObjects ?? true,
    presets: flags?.presets ?? true,
    seedPropose: queryModel !== "kv" && queryModel !== "search",
    checkpointRestore: flags?.checkpointRestore ?? true,
    sqlWritePreview: queryModel === "sql",
    documentPropose: queryModel === "document",
  };
}

export function isAgentToolEnabled(
  name: AIAgentToolName,
  availability: Pick<AgentToolAvailability, "sqlRead" | "sqlWritePreview" | "documentPropose"> &
    Partial<
      Pick<
        AgentToolAvailability,
        | "parameterizedRead"
        | "previewWrite"
        | "schemaObjects"
        | "presets"
        | "seedPropose"
        | "checkpointRestore"
      >
    >,
): boolean {
  // Missing capability flags fall back to the pre-flag semantics so narrow
  // callers (e.g. the catalog defaults) keep the old behavior exactly.
  if (name === "run_readonly_sql" || name === "check_sql") return availability.sqlRead;
  if (name === "run_parameterized_sql" || name === "find_value") {
    return availability.parameterizedRead ?? availability.sqlRead;
  }
  if (name === "list_schema_objects") {
    return availability.schemaObjects ?? availability.sqlRead;
  }
  if (name === "run_preset") return availability.presets ?? availability.sqlRead;
  if (name === "preview_write") {
    return availability.previewWrite ?? availability.sqlWritePreview;
  }
  if (name === "propose_seed_data") {
    return (
      availability.seedPropose ?? (availability.sqlWritePreview || availability.documentPropose)
    );
  }
  if (name === "restore_checkpoint") return availability.checkpointRestore ?? true;
  return true;
}

export function agentSqlToolBlockedMessage(
  name:
    | "run_readonly_sql"
    | "run_parameterized_sql"
    | "find_value"
    | "check_sql"
    | "preview_write"
    | "list_schema_objects"
    | "run_preset"
    | "propose_seed_data"
    | "restore_checkpoint",
  availability: AgentToolAvailability,
): string {
  if (name === "run_readonly_sql") {
    return `Tool blocked: run_readonly_sql is not available on ${availability.engineLabel}. This engine does not speak SQL. Use list_tables, describe_table, search_schema, or sample_table_data instead.`;
  }
  if (name === "check_sql") {
    return `Tool blocked: check_sql is not available on ${availability.engineLabel}. This engine does not speak SQL, so there is no SQL to pre-flight.`;
  }
  if (name === "run_parameterized_sql" || name === "find_value") {
    return `Tool blocked: ${name} is not available on ${availability.engineLabel}. This engine does not support parameterized SQL reads. Use list_tables, describe_table, search_schema, or sample_table_data instead.`;
  }
  if (name === "preview_write") {
    return `Tool blocked: preview_write is not available on ${availability.engineLabel}. This driver cannot run statements inside a rollback-only transaction.`;
  }
  if (name === "list_schema_objects") {
    return `Tool blocked: list_schema_objects is not available on ${availability.engineLabel}. This engine has no SQL schema objects (views, triggers, routines). Use list_tables and describe_table instead.`;
  }
  if (name === "run_preset") {
    return `Tool blocked: run_preset is not available on ${availability.engineLabel}. No admin preset can run through this engine's sandboxed transport.`;
  }
  if (name === "propose_seed_data") {
    return `Tool blocked: propose_seed_data is not available on ${availability.engineLabel}. It fills a table or collection with sample data on SQL engines, Cassandra, and MongoDB only.`;
  }
  return `Tool blocked: restore_checkpoint is not available on ${availability.engineLabel}. Checkpoints are SQL dumps this engine cannot re-execute.`;
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
    gather: `You are an autonomous agent on ${availability.engineLabel}, which does not speak SQL. Decide your own steps: locate unknown fields with search_schema, inspect the exact table with describe_table, then ACTUALLY gather data with sample_table_data. Never call run_readonly_sql or preview_write.${availability.documentPropose ? " To fill an empty collection, call propose_seed_data — the seed script opens in a query tab for the user to run." : ""}`,
    mustRead:
      "When the user asks to see data, charts, counts, samples, distributions, or 'show me' anything, you MUST run sample_table_data before finishing. Finishing with only suggestions and no executed query is a failure.",
    finishSql: "When you finish, omit finish.args.sql. Put the answer in finish.args.response.",
  };
}
