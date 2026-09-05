import { invokeMutation } from "../utils/tauri-utils";
import type { QueryResult, ConnectionConfig } from "../types";
import { resolveEnvVars } from "../utils/env-resolve";
import type { ConnectionState } from "./connectionStore";

/** Frontend-side timeouts (ms) for backend metadata and connection calls. */
export const FRONTEND_TIMEOUTS = {
  connection: 45_000,
  metadata: 15_000,
} as const;

const MISSING_CONNECTION_ERROR_PATTERNS = [/please connect first/i];
export const inFlightTableFetches = new Map<string, Promise<void>>();
export const inFlightSchemaObjectFetches = new Map<string, Promise<void>>();

/**
 * Runs `task` under per-key dedup: concurrent calls sharing `key` await the
 * same in-flight promise instead of issuing duplicate backend requests.
 */
export async function runWithInFlight(
  registry: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<void>,
): Promise<void> {
  const pending = registry.get(key);
  if (pending) return pending;
  const request = task();
  registry.set(key, request);
  try {
    await request;
  } finally {
    registry.delete(key);
  }
}

export const sanitizeConnectionConfig = (config: ConnectionConfig): ConnectionConfig => {
  const raw = config as ConnectionConfig & { startup_commands?: string };
  return {
    ...config,
    startupCommands: config.startupCommands ?? raw.startup_commands,
    password: undefined,
    ssh_config: config.ssh_config
      ? {
          ...config.ssh_config,
          password: undefined,
          privateKey: undefined,
          passphrase: undefined,
        }
      : undefined,
  };
};

export function deriveConnectionName(config: ConnectionConfig): string {
  const explicitName = config.name.trim();
  if (explicitName) return explicitName;

  if (config.db_type === "sqlite" || config.db_type === "duckdb") {
    const filePath = (config.file_path || "").trim();
    if (filePath) {
      const normalizedPath = filePath.replace(/\\/g, "/");
      const fileName = normalizedPath.split("/").filter(Boolean).pop() || filePath;
      return `${config.db_type === "duckdb" ? "DuckDB" : "SQLite"} ${fileName}`;
    }
    return config.db_type === "duckdb" ? "DuckDB local" : "SQLite local";
  }

  const host = (config.host || "").trim();
  const database = (config.database || "").trim();
  const dbLabel = config.db_type.toUpperCase();
  if (host && database) return `${dbLabel} ${host} / ${database}`;
  if (database) return `${dbLabel} ${database}`;
  if (host) return `${dbLabel} ${host}`;
  return `${dbLabel} connection`;
}

export function resolveConnectionConfig(config: ConnectionConfig): ConnectionConfig {
  // Port must survive serde as u16 (0..=65535) — a stray negative or empty
  // value from the number input would otherwise reject the whole command.
  const port =
    config.port != null &&
    Number.isInteger(config.port) &&
    config.port > 0 &&
    config.port <= 65535
      ? config.port
      : undefined;
  const resolvedConfig = {
    ...config,
    port,
    host: config.host ? resolveEnvVars(config.host) : config.host,
    username: config.username ? resolveEnvVars(config.username) : config.username,
    password: config.password ? resolveEnvVars(config.password) : config.password,
    database: config.database ? resolveEnvVars(config.database) : config.database,
    file_path: config.file_path ? resolveEnvVars(config.file_path) : config.file_path,
    additional_fields: config.additional_fields
      ? Object.fromEntries(
          Object.entries(config.additional_fields).map(([key, value]) => [
            key,
            typeof value === "string" ? resolveEnvVars(value) : value,
          ]),
        )
      : config.additional_fields,
  };

  return {
    ...resolvedConfig,
    name: deriveConnectionName(resolvedConfig),
  };
}

export function metadataFetchKey(connectionId: string, database?: string): string {
  return `${connectionId}:${database ?? ""}`;
}

export function isMissingConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return MISSING_CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export async function executeStartupCommands(connectionId: string, commands: string): Promise<void> {
  const statements = commands
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const sql of statements) {
    try {
      await invokeMutation<QueryResult>("execute_query", { connectionId, sql });
    } catch (error) {
      console.warn("[StartupCommands] Failed to execute:", sql, error);
    }
  }
}


/** Computes the post-disconnect state patch for the given connection. */
export function disconnectedPatch(
  state: Pick<ConnectionState, "activeConnectionId" | "connectedIds">,
  connectionId: string,
): Partial<ConnectionState> {
  const connectedIds = new Set(state.connectedIds);
  connectedIds.delete(connectionId);
  if (state.activeConnectionId !== connectionId) return { connectedIds };
  return {
    connectedIds,
    activeConnectionId: null,
    currentDatabase: null,
    databases: [],
    tables: [],
    schemaObjects: [],
  };
}
