import { create } from "zustand";

import type {
  ConnectionConfig,
  DatabaseInfo,
  SchemaObjectInfo,
  TableInfo,
} from "../types";
import { invokeAIWorkspaceToolWithTimeout } from "../utils/ai-tool-command-client";
import { invokeMutation, invokeWithTimeout } from "../utils/tauri-utils";
import {
  getOrLoadSchemaObjects,
  getOrLoadSchemaTables,
  invalidateSchemaCache,
} from "../utils/schema-cache";
import { useGlobalErrorStore } from "./globalErrorStore";
import { useUIStore } from "./uiStore";
import { invalidateConnectionCapabilities } from "../hooks/useConnectionCapabilities";
import {
  disconnectedPatch,
  executeStartupCommands,
  FRONTEND_TIMEOUTS,
  inFlightSchemaObjectFetches,
  inFlightTableFetches,
  isMissingConnectionError,
  metadataFetchKey,
  resolveConnectionConfig,
  runWithInFlight,
  sanitizeConnectionConfig,
} from "./connectionStoreHelpers";

export { deriveConnectionName } from "./connectionStoreHelpers";

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

export const useConnectionStore = create<ConnectionState>((set, get) => {
  type ConnectSnapshot = Pick<
    ConnectionState,
    "activeConnectionId" | "currentDatabase" | "tables" | "schemaObjects"
  >;

  const snapshotForRestore = (): ConnectSnapshot => ({
    activeConnectionId: get().activeConnectionId,
    currentDatabase: get().currentDatabase,
    tables: get().tables,
    schemaObjects: get().schemaObjects,
  });

  const markConnected = (
    connectionId: string,
    database: string | null | undefined,
    connectionsPatch?: { connections: ConnectionConfig[] },
  ) => {
    const connectedIds = new Set(get().connectedIds);
    connectedIds.add(connectionId);
    set({
      ...(connectionsPatch ?? {}),
      connectedIds,
      activeConnectionId: connectionId,
      currentDatabase: database ?? null,
      schemaObjects: [],
      ...(database ? {} : { tables: [] }),
      isConnecting: false,
    });
  };

  const restoreOrClearOnConnectError = (error: unknown, targetId: string, previousState: ConnectSnapshot) => {
    if (get().activeConnectionId === targetId) {
      set({ ...previousState, isConnecting: false });
    } else {
      set({ isConnecting: false });
    }
    useGlobalErrorStore.getState().setError(`Connection to target failed: ${error}`);
    throw error;
  };

  const loadMetadataAfterConnect = (connectionId: string, database: string | null | undefined) => {
    void get().fetchDatabases(connectionId);
    if (database) {
      void get().fetchTables(connectionId, database);
      void get().fetchSchemaObjects(connectionId, database);
    }
  };

  return {

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
    // Skip identical writes so subscribers are not notified needlessly.
    if (get().connectionHealth[connectionId] === healthy) return;
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
    const previousState = snapshotForRestore();
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
      const requestId = crypto.randomUUID();
      await invokeWithTimeout(
        "connect_database",
        { config: normalizedConfig, requestId },
        FRONTEND_TIMEOUTS.connection,
        "Connecting to database",
        {
          onTimeout: () => {
            void invokeMutation("cancel_connection_attempt", { requestId });
          },
        },
      );
      invalidateConnectionCapabilities(normalizedConfig.id);

      const savedConfig = sanitizeConnectionConfig(normalizedConfig);
      markConnected(normalizedConfig.id, normalizedConfig.database, {
        connections: connections.some((item) => item.id === normalizedConfig.id)
          ? connections.map((item) => (item.id === normalizedConfig.id ? savedConfig : item))
          : [...connections, savedConfig],
      });

      await executeStartupCommands(
        normalizedConfig.id,
        normalizedConfig.startupCommands ?? "",
      );
      loadMetadataAfterConnect(normalizedConfig.id, normalizedConfig.database);
    } catch (error) {
      restoreOrClearOnConnectError(error, normalizedConfig.id, previousState);
    }
  },

  connectSavedConnection: async (connectionId) => {
    if (get().isConnecting) return;
    const previousState = snapshotForRestore();
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
      invalidateConnectionCapabilities(connectionId);
      markConnected(connectionId, connection?.database);

      await executeStartupCommands(connectionId, connection?.startupCommands ?? "");
      loadMetadataAfterConnect(connectionId, connection?.database);
    } catch (error) {
      restoreOrClearOnConnectError(error, connectionId, previousState);
    }
  },

  disconnectFromDatabase: async (connectionId) => {
    try {
      await invokeMutation("disconnect_database", { connectionId });
      invalidateConnectionCapabilities(connectionId);
      set(disconnectedPatch(get(), connectionId));
      useUIStore.getState().removeTabsForConnection(connectionId);
    } catch (error) {
      useGlobalErrorStore.getState().setError(`Disconnect failed: ${error}`);
    }
  },

  testConnection: async (config) => {
    const requestId = crypto.randomUUID();
    return invokeWithTimeout<string>(
      "test_connection",
      { config: resolveConnectionConfig(config), requestId },
      FRONTEND_TIMEOUTS.connection,
      "Testing database connection",
      {
        onTimeout: () => {
          void invokeMutation("cancel_connection_attempt", { requestId });
        },
      },
    );
  },

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

  fetchTables: async (connectionId, database) =>
    runWithInFlight(inFlightTableFetches, metadataFetchKey(connectionId, database), async () => {
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
    }),

  fetchSchemaObjects: async (connectionId, database) =>
    runWithInFlight(inFlightSchemaObjectFetches, metadataFetchKey(connectionId, database), async () => {
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
    }),

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
  };
});
