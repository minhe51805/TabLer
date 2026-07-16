import { create } from "zustand";

import type {
  ConnectionConfig,
  DatabaseInfo,
  QueryResult,
  SchemaObjectInfo,
  TableInfo,
} from "../types";
import { invokeAIWorkspaceToolWithTimeout } from "../utils/ai-tool-command-client";
import { resolveEnvVars } from "../utils/env-resolve";
import { invokeMutation, invokeWithTimeout } from "../utils/tauri-utils";
import {
  getOrLoadSchemaObjects,
  getOrLoadSchemaTables,
  invalidateSchemaCache,
} from "../utils/schema-cache";
import { useGlobalErrorStore } from "./globalErrorStore";
import { useUIStore } from "./uiStore";

const FRONTEND_TIMEOUTS = {
  connection: 30_000,
  metadata: 15_000,
} as const;

const MISSING_CONNECTION_ERROR_PATTERNS = [/please connect first/i];
const inFlightTableFetches = new Map<string, Promise<void>>();
const inFlightSchemaObjectFetches = new Map<string, Promise<void>>();

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

function resolveConnectionConfig(config: ConnectionConfig): ConnectionConfig {
  const resolvedConfig = {
    ...config,
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

function metadataFetchKey(connectionId: string, database?: string): string {
  return `${connectionId}:${database ?? ""}`;
}

function isMissingConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return MISSING_CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

async function executeStartupCommands(connectionId: string, commands: string): Promise<void> {
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

export interface ConnectionState {
  connections: ConnectionConfig[];
  activeConnectionId: string | null;
  connectedIds: Set<string>;
  databases: DatabaseInfo[];
  currentDatabase: string | null;
  tables: TableInfo[];
  schemaObjects: SchemaObjectInfo[];
  connectionHealth: Record<string, boolean>;
  isConnecting: boolean;
  isLoadingDatabases: boolean;
  isSwitchingDatabase: boolean;
  isLoadingTables: boolean;
  isLoadingSchemaObjects: boolean;

  setConnectionHealth: (connectionId: string, healthy: boolean) => void;
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
  invalidateSchemaMetadata: (connectionId: string, database?: string) => void;
  createLocalDatabase: (
    config: ConnectionConfig,
    databaseName: string,
    bootstrapStatements?: string[],
  ) => Promise<string>;
  suggestSqliteDatabasePath: (databaseName: string) => Promise<string>;
  pickSqliteDatabasePath: (databaseName: string) => Promise<string | null>;
}

function disconnectedPatch(
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

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  activeConnectionId: null,
  connectedIds: new Set(),
  databases: [],
  currentDatabase: null,
  tables: [],
  schemaObjects: [],
  connectionHealth: {},
  isConnecting: false,
  isLoadingDatabases: false,
  isSwitchingDatabase: false,
  isLoadingTables: false,
  isLoadingSchemaObjects: false,

  setConnectionHealth: (connectionId, healthy) => {
    set((state) => ({
      connectionHealth: { ...state.connectionHealth, [connectionId]: healthy },
    }));
  },

  loadSavedConnections: async () => {
    try {
      const connections = await invokeWithTimeout<ConnectionConfig[]>(
        "get_saved_connections",
        {},
        FRONTEND_TIMEOUTS.metadata,
        "Loading saved connections",
      );
      set({ connections: connections.map(sanitizeConnectionConfig) });
    } catch (error) {
      useGlobalErrorStore.getState().setError(`Failed to load connections: ${error}`);
    }
  },

  connectToDatabase: async (config) => {
    if (get().isConnecting) return;
    const previousState = {
      activeConnectionId: get().activeConnectionId,
      currentDatabase: get().currentDatabase,
      tables: get().tables,
      schemaObjects: get().schemaObjects,
    };
    const normalizedConfig = resolveConnectionConfig(config);
    set({
      isConnecting: true,
      activeConnectionId: normalizedConfig.id,
      currentDatabase: normalizedConfig.database ?? null,
      schemaObjects: [],
      ...(normalizedConfig.database ? {} : { tables: [] }),
    });

    try {
      const connections = get().connections;
      await invokeMutation("connect_database", { config: normalizedConfig });

      const connectedIds = new Set(get().connectedIds);
      connectedIds.add(normalizedConfig.id);
      const savedConfig = sanitizeConnectionConfig(normalizedConfig);
      const nextConnections = connections.some((item) => item.id === normalizedConfig.id)
        ? connections.map((item) => (item.id === normalizedConfig.id ? savedConfig : item))
        : [...connections, savedConfig];

      set({
        connectedIds,
        activeConnectionId: normalizedConfig.id,
        connections: nextConnections,
        currentDatabase: normalizedConfig.database ?? null,
        schemaObjects: [],
        ...(normalizedConfig.database ? {} : { tables: [] }),
        isConnecting: false,
      });

      await executeStartupCommands(
        normalizedConfig.id,
        normalizedConfig.startupCommands ?? "",
      );
      void get().fetchDatabases(normalizedConfig.id);
      if (normalizedConfig.database) {
        void get().fetchTables(normalizedConfig.id, normalizedConfig.database);
        void get().fetchSchemaObjects(normalizedConfig.id, normalizedConfig.database);
      }
    } catch (error) {
      if (get().activeConnectionId === normalizedConfig.id) {
        set({ ...previousState, isConnecting: false });
      } else {
        set({ isConnecting: false });
      }
      useGlobalErrorStore.getState().setError(`Connection to target failed: ${error}`);
      throw error;
    }
  },

  connectSavedConnection: async (connectionId) => {
    if (get().isConnecting) return;
    const previousState = {
      activeConnectionId: get().activeConnectionId,
      currentDatabase: get().currentDatabase,
      tables: get().tables,
      schemaObjects: get().schemaObjects,
    };
    const connection = get().connections.find((item) => item.id === connectionId);
    set({
      isConnecting: true,
      activeConnectionId: connectionId,
      currentDatabase: connection?.database ?? null,
      schemaObjects: [],
      ...(connection?.database ? {} : { tables: [] }),
    });

    try {
      await invokeMutation("connect_saved_connection", { connectionId });
      const connectedIds = new Set(get().connectedIds);
      connectedIds.add(connectionId);
      set({
        connectedIds,
        activeConnectionId: connectionId,
        currentDatabase: connection?.database ?? null,
        schemaObjects: [],
        ...(connection?.database ? {} : { tables: [] }),
        isConnecting: false,
      });

      await executeStartupCommands(connectionId, connection?.startupCommands ?? "");
      void get().fetchDatabases(connectionId);
      if (connection?.database) {
        void get().fetchTables(connectionId, connection.database);
        void get().fetchSchemaObjects(connectionId, connection.database);
      }
    } catch (error) {
      if (get().activeConnectionId === connectionId) {
        set({ ...previousState, isConnecting: false });
      } else {
        set({ isConnecting: false });
      }
      useGlobalErrorStore.getState().setError(`Connection to target failed: ${error}`);
      throw error;
    }
  },

  disconnectFromDatabase: async (connectionId) => {
    try {
      await invokeMutation("disconnect_database", { connectionId });
      set(disconnectedPatch(get(), connectionId));
      useUIStore.getState().removeTabsForConnection(connectionId);
    } catch (error) {
      useGlobalErrorStore.getState().setError(`Disconnect failed: ${error}`);
    }
  },

  testConnection: async (config) =>
    invokeWithTimeout<string>(
      "test_connection",
      { config: resolveConnectionConfig(config) },
      FRONTEND_TIMEOUTS.connection,
      "Testing database connection",
    ),

  deleteSavedConnection: async (connectionId) => {
    try {
      await invokeMutation("delete_saved_connection", { connectionId });
      set({
        connections: get().connections.filter((connection) => connection.id !== connectionId),
      });
      useUIStore.getState().removeTabsForConnection(connectionId);
    } catch (error) {
      useGlobalErrorStore.getState().setError(`Delete failed: ${error}`);
    }
  },

  fetchDatabases: async (connectionId) => {
    set({ isLoadingDatabases: true });
    try {
      const databases = await invokeWithTimeout<DatabaseInfo[]>(
        "list_databases",
        { connectionId },
        FRONTEND_TIMEOUTS.metadata,
        "Listing databases",
      );
      set({ databases, isLoadingDatabases: false });
    } catch (error) {
      const message = `Failed to list databases: ${error}`;
      set({
        isLoadingDatabases: false,
        ...(isMissingConnectionError(error) ? disconnectedPatch(get(), connectionId) : {}),
      });
      useGlobalErrorStore.getState().setError(message);
    }
  },

  switchDatabase: async (connectionId, database) => {
    set({ isSwitchingDatabase: true });
    try {
      await invokeMutation("use_database", { connectionId, database });
      set({ currentDatabase: database, schemaObjects: [], isSwitchingDatabase: false });
      await Promise.all([
        get().fetchTables(connectionId, database),
        get().fetchSchemaObjects(connectionId, database),
      ]);
    } catch (error) {
      set({
        isSwitchingDatabase: false,
        ...(isMissingConnectionError(error) ? disconnectedPatch(get(), connectionId) : {}),
      });
      useGlobalErrorStore.getState().setError(`Failed to switch database: ${error}`);
    }
  },

  fetchTables: async (connectionId, database) => {
    const key = metadataFetchKey(connectionId, database);
    const pending = inFlightTableFetches.get(key);
    if (pending) return pending;

    const request = (async () => {
      set({ isLoadingTables: true });
      try {
        const tables = await getOrLoadSchemaTables(
          { connectionId, database },
          () => invokeAIWorkspaceToolWithTimeout(
            "list_tables",
            { connectionId, database: database || null },
            FRONTEND_TIMEOUTS.metadata,
            "Listing tables",
          ),
        );
        set({ tables, isLoadingTables: false });
      } catch (error) {
        set({
          isLoadingTables: false,
          ...(isMissingConnectionError(error) ? disconnectedPatch(get(), connectionId) : {}),
        });
        useGlobalErrorStore
          .getState()
          .setError(`Failed to list tables: ${error}`);
      }
    })();

    inFlightTableFetches.set(key, request);
    try {
      await request;
    } finally {
      inFlightTableFetches.delete(key);
    }
  },

  fetchSchemaObjects: async (connectionId, database) => {
    const key = metadataFetchKey(connectionId, database);
    const pending = inFlightSchemaObjectFetches.get(key);
    if (pending) return pending;

    const request = (async () => {
      set({ isLoadingSchemaObjects: true });
      try {
        const schemaObjects = await getOrLoadSchemaObjects(
          { connectionId, database },
          () => invokeWithTimeout<SchemaObjectInfo[]>(
            "list_schema_objects",
            { connectionId, database: database || null },
            FRONTEND_TIMEOUTS.metadata,
            "Listing schema objects",
          ),
        );
        set({ schemaObjects, isLoadingSchemaObjects: false });
      } catch (error) {
        set({
          isLoadingSchemaObjects: false,
          ...(isMissingConnectionError(error) ? disconnectedPatch(get(), connectionId) : {}),
        });
        useGlobalErrorStore
          .getState()
          .setError(`Failed to list schema objects: ${error}`);
      }
    })();

    inFlightSchemaObjectFetches.set(key, request);
    try {
      await request;
    } finally {
      inFlightSchemaObjectFetches.delete(key);
    }
  },

  invalidateSchemaMetadata: (connectionId, database) => {
    invalidateSchemaCache(connectionId, database);

    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("schema-cache-invalidated", { detail: { connectionId, database } }),
      );
    }

    const state = get();
    const activeDatabase = state.currentDatabase ?? undefined;
    if (state.activeConnectionId === connectionId && (database === undefined || database === activeDatabase)) {
      void Promise.all([
        state.fetchTables(connectionId, activeDatabase),
        state.fetchSchemaObjects(connectionId, activeDatabase),
      ]);
    }
  },

  createLocalDatabase: async (config, databaseName, bootstrapStatements = []) => {
    try {
      return await invokeMutation<string>("create_local_database", {
        config: resolveConnectionConfig(config),
        databaseName,
        bootstrapStatements: bootstrapStatements.length > 0 ? bootstrapStatements : null,
      });
    } catch (error) {
      useGlobalErrorStore.getState().setError(`Create database failed: ${error}`);
      throw error;
    }
  },

  suggestSqliteDatabasePath: async (databaseName) =>
    invokeWithTimeout<string>(
      "suggest_sqlite_database_path",
      { databaseName },
      FRONTEND_TIMEOUTS.metadata,
      "Preparing SQLite database location",
    ),

  pickSqliteDatabasePath: async (databaseName) =>
    invokeWithTimeout<string | null>(
      "pick_sqlite_database_path",
      { databaseName },
      FRONTEND_TIMEOUTS.metadata,
      "Opening SQLite save dialog",
    ),
}));
