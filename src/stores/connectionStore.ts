import { create } from "zustand";
import { invokeWithTimeout, invokeMutation } from "../utils/tauri-utils";
import { resolveEnvVars } from "../utils/env-resolve";
import type { ConnectionConfig, DatabaseInfo, TableInfo, SchemaObjectInfo } from "../types";

const sanitizeConnectionConfig = (config: ConnectionConfig): ConnectionConfig => ({
  ...config,
  password: undefined,
});

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

const ensureConnectionName = (config: ConnectionConfig): ConnectionConfig => ({
  ...config,
  name: deriveConnectionName(config),
});

const FRONTEND_TIMEOUT_MS = 30_000;

interface ConnectionState {
  connections: ConnectionConfig[];
  activeConnectionId: string | null;
  connectedIds: Set<string>;
  databases: DatabaseInfo[];
  currentDatabase: string | null;
  tables: TableInfo[];
  schemaObjects: SchemaObjectInfo[];
  isConnecting: boolean;
  isLoadingTables: boolean;

  loadSavedConnections: () => Promise<void>;
  connectToDatabase: (config: ConnectionConfig) => Promise<void>;
  connectSavedConnection: (connectionId: string) => Promise<void>;
  disconnectFromDatabase: (connectionId: string) => Promise<void>;
  testConnection: (config: ConnectionConfig) => Promise<string>;
  deleteSavedConnection: (connectionId: string) => Promise<void>;
  fetchDatabases: (connectionId: string) => Promise<void>;
  switchDatabase: (connectionId: string, database: string) => Promise<void>;
  fetchTables: (connectionId: string, database?: string) => Promise<void>;
  fetchSchemaObjects: (connectionId: string, database?: string) => Promise<void>;
  createLocalDatabase: (config: ConnectionConfig, databaseName: string, bootstrapStatements?: string[]) => Promise<string>;
  suggestSqliteDatabasePath: (databaseName: string) => Promise<string>;
  pickSqliteDatabasePath: (databaseName: string) => Promise<string | null>;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  activeConnectionId: null,
  connectedIds: new Set(),
  databases: [],
  currentDatabase: null,
  tables: [],
  schemaObjects: [],
  isConnecting: false,
  isLoadingTables: false,

  loadSavedConnections: async () => {
    try {
      const connections = await invokeWithTimeout<ConnectionConfig[]>(
        "get_saved_connections", {}, FRONTEND_TIMEOUT_MS, "Loading saved connections"
      );
      set({ connections: connections.map(sanitizeConnectionConfig) });
    } catch (e) {
      console.error("Failed to load connections:", e);
    }
  },

  connectToDatabase: async (config: ConnectionConfig) => {
    if (get().isConnecting) return;
    set({ isConnecting: true });
    try {
      const resolvedConfig: ConnectionConfig = {
        ...config,
        host: config.host ? resolveEnvVars(config.host) : config.host,
        port: config.port,
        username: config.username ? resolveEnvVars(config.username) : config.username,
        password: config.password ? resolveEnvVars(config.password) : config.password,
        database: config.database ? resolveEnvVars(config.database) : config.database,
        file_path: config.file_path ? resolveEnvVars(config.file_path) : config.file_path,
        additional_fields: config.additional_fields
          ? Object.fromEntries(
              Object.entries(config.additional_fields).map(
                ([k, v]) => [k, typeof v === "string" ? resolveEnvVars(v) : v]
              )
            )
          : config.additional_fields,
      };
      const normalizedConfig = ensureConnectionName(resolvedConfig);
      const connections = get().connections;
      const sameId = connections.find((c) => c.id === normalizedConfig.id);
      const connectionRequest = normalizedConfig;
      const finalConfig = sanitizeConnectionConfig(normalizedConfig);

      await invokeMutation("connect_database", { config: connectionRequest });

      const connectedIds = new Set(get().connectedIds);
      connectedIds.add(normalizedConfig.id);

      let newConnections = connections;
      if (sameId) {
        newConnections = connections.map((c) => (c.id === normalizedConfig.id ? finalConfig : c));
      } else {
        newConnections = [...connections, finalConfig];
      }

      set({
        connectedIds,
        activeConnectionId: normalizedConfig.id,
        connections: newConnections,
        currentDatabase: normalizedConfig.database ?? null,
        ...(normalizedConfig.database ? {} : { tables: [], schemaObjects: [] }),
        isConnecting: false,
      });

      await get().fetchDatabases(normalizedConfig.id);
      if (normalizedConfig.database) {
        set({ currentDatabase: normalizedConfig.database });
        await Promise.all([
          get().fetchTables(normalizedConfig.id, normalizedConfig.database),
          get().fetchSchemaObjects(normalizedConfig.id, normalizedConfig.database),
        ]);
      }
    } catch (e) {
      set({ isConnecting: false });
      console.error("Connection failed:", e);
      throw e;
    }
  },

  connectSavedConnection: async (connectionId: string) => {
    if (get().isConnecting) return;
    set({ isConnecting: true });
    try {
      await invokeMutation("connect_saved_connection", { connectionId });
      const connection = get().connections.find((item) => item.id === connectionId);
      const connectedIds = new Set(get().connectedIds);
      connectedIds.add(connectionId);

      set({
        connectedIds,
        activeConnectionId: connectionId,
        currentDatabase: connection?.database ?? null,
        ...(connection?.database ? {} : { tables: [], schemaObjects: [] }),
        isConnecting: false,
      });

      await get().fetchDatabases(connectionId);
      if (connection?.database) {
        set({ currentDatabase: connection.database });
        await Promise.all([
          get().fetchTables(connectionId, connection.database),
          get().fetchSchemaObjects(connectionId, connection.database),
        ]);
      }
    } catch (e) {
      set({ isConnecting: false });
      console.error("Connection failed:", e);
      throw e;
    }
  },

  disconnectFromDatabase: async (connectionId: string) => {
    try {
      await invokeMutation("disconnect_database", { connectionId });
      const connectedIds = new Set(get().connectedIds);
      connectedIds.delete(connectionId);

      const newState: Partial<ConnectionState> = { connectedIds };
      if (get().activeConnectionId === connectionId) {
        newState.activeConnectionId = null;
        newState.databases = [];
        newState.tables = [];
        newState.schemaObjects = [];
        newState.currentDatabase = null;
      }
      set(newState);
    } catch (e) {
      console.error("Disconnect failed:", e);
    }
  },

  testConnection: async (config: ConnectionConfig) => {
    // Resolve env vars in the config before sending to backend
    const resolvedConfig: ConnectionConfig = {
      ...config,
      host: config.host ? resolveEnvVars(config.host) : config.host,
      port: config.port,
      username: config.username ? resolveEnvVars(config.username) : config.username,
      password: config.password ? resolveEnvVars(config.password) : config.password,
      database: config.database ? resolveEnvVars(config.database) : config.database,
      file_path: config.file_path ? resolveEnvVars(config.file_path) : config.file_path,
      additional_fields: config.additional_fields
        ? Object.fromEntries(
            Object.entries(config.additional_fields).map(
              ([k, v]) => [k, typeof v === "string" ? resolveEnvVars(v) : v]
            )
          )
        : config.additional_fields,
    };
    return invokeWithTimeout<string>(
      "test_connection",
      { config: ensureConnectionName(resolvedConfig) },
      FRONTEND_TIMEOUT_MS,
      "Testing database connection"
    );
  },

  deleteSavedConnection: async (connectionId: string) => {
    try {
      await invokeMutation("delete_saved_connection", { connectionId });
      set({ connections: get().connections.filter((c) => c.id !== connectionId) });
    } catch (e) {
      console.error("Delete failed:", e);
    }
  },

  fetchDatabases: async (connectionId: string) => {
    try {
      const databases = await invokeWithTimeout<DatabaseInfo[]>(
        "list_databases", { connectionId }, 15_000, "Listing databases"
      );
      set({ databases });
    } catch (e) {
      console.error("Failed to list databases:", e);
    }
  },

  switchDatabase: async (connectionId: string, database: string) => {
    try {
      await invokeMutation("use_database", { connectionId, database });
      set({ currentDatabase: database });
      await Promise.all([
        get().fetchTables(connectionId, database),
        get().fetchSchemaObjects(connectionId, database),
      ]);
    } catch (e) {
      console.error("Failed to switch database:", e);
    }
  },

  fetchTables: async (connectionId: string, database?: string) => {
    set({ isLoadingTables: true });
    try {
      const tables = await invokeWithTimeout<TableInfo[]>(
        "list_tables", { connectionId, database: database || null }, 15_000, "Listing tables"
      );
      set({ tables, isLoadingTables: false });
    } catch (e) {
      set({ isLoadingTables: false });
      console.error("Failed to list tables:", e);
    }
  },

  fetchSchemaObjects: async (connectionId: string, database?: string) => {
    try {
      const schemaObjects = await invokeWithTimeout<SchemaObjectInfo[]>(
        "list_schema_objects", { connectionId, database: database || null }, 15_000, "Listing schema objects"
      );
      set({ schemaObjects });
    } catch (e) {
      console.error("Failed to list schema objects:", e);
    }
  },

  createLocalDatabase: async (config: ConnectionConfig, databaseName: string, bootstrapStatements = []) => {
    try {
      return await invokeMutation<string>("create_local_database", {
        config: ensureConnectionName(config),
        databaseName,
        bootstrapStatements: bootstrapStatements.length > 0 ? bootstrapStatements : null,
      });
    } catch (e) {
      console.error("Create database failed:", e);
      throw e;
    }
  },

  suggestSqliteDatabasePath: async (databaseName: string) =>
    invokeWithTimeout<string>(
      "suggest_sqlite_database_path", { databaseName }, 15_000, "Preparing SQLite database location"
    ),

  pickSqliteDatabasePath: async (databaseName: string) =>
    invokeWithTimeout<string | null>(
      "pick_sqlite_database_path", { databaseName }, 15_000, "Opening SQLite save dialog"
    ),
}));
