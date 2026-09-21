import { create } from "zustand";

import type { ConnectionConfig, DatabaseInfo, SchemaObjectInfo, TableInfo } from "../types";
import { invokeAIWorkspaceToolWithTimeout } from "../utils/ai-tool-command-client";
import { parseConnectionError, type ConnectionErrorDetails } from "../utils/connection-error";
import { invokeMutation, invokeWithTimeout } from "../utils/tauri-utils";
import {
  getOrLoadSchemaObjects,
  getOrLoadSchemaTables,
  invalidateSchemaCache,
} from "../utils/schema-cache";
import { useGlobalErrorStore } from "./globalErrorStore";
import { useUIStore } from "./uiStore";
import { invalidateConnectionCapabilities } from "../hooks/useConnectionCapabilities";
import { applyConnectionAssignments } from "./connection-group-store";
import { notifyProfilerConnectionClosed } from "../components/Profiler/profilerWindow";
import {
  disconnectedPatch,
  executeStartupCommands,
  FRONTEND_TIMEOUTS,
  inFlightSchemaObjectFetches,
  inFlightTableFetches,
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
  /** Most recently connected saved-connection ids, newest first (max 5).
   *  Persisted to localStorage; powers the palette's Recent section. */
  recentConnectionIds: string[];
  isConnecting: boolean;
  isLoadingDatabases: boolean;
  isSwitchingDatabase: boolean;
  isLoadingTables: boolean;
  isLoadingSchemaObjects: boolean;
  /**
   * Set when a saved-connection attempt fails: the failing connection id plus
   * the classified error (stage + message + hint). Drives the in-place error
   * state of <WorkspaceConnecting> (stage badge + hint + Try Again + Go to
   * Launcher) so a failed connect keeps the SAME connecting screen mounted
   * instead of bouncing back to the launcher with a detached error bar.
   * Cleared on a new attempt, on success, and when the user
   * leaves for the launcher.
   */
  connectError: ({ id: string } & ConnectionErrorDetails) | null;

  setConnectionHealth: (connectionId: string, healthy: boolean) => void;
  clearConnectionError: () => void;
  cancelConnectionAttempt: () => void;
  loadSavedConnections: () => Promise<void>;
  connectToDatabase: (config: ConnectionConfig) => Promise<void>;
  connectSavedConnection: (connectionId: string) => Promise<void>;
  disconnectFromDatabase: (connectionId: string, options?: { keepTabs?: boolean }) => Promise<void>;
  testConnection: (config: ConnectionConfig) => Promise<string>;
  deleteSavedConnection: (connectionId: string) => Promise<void>;
  renameSavedConnection: (connectionId: string, name: string) => Promise<void>;
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
  /** Create (or reuse) the bundled SQLite demo database, persist it as a saved
   *  connection, and return the saved config so the caller can connect. */
  createSampleDatabase: () => Promise<ConnectionConfig>;
}

const SYSTEM_DATABASE_NAMES = new Set([
  "master",
  "tempdb",
  "model",
  "msdb",
  "mysql",
  "sys",
  "performance_schema",
  "information_schema",
  "postgres",
  "template0",
  "template1",
  "rdsadmin",
]);

const RECENT_CONNECTIONS_KEY = "tabler.recentConnections";
const MAX_RECENT_CONNECTIONS = 5;

function loadRecentConnectionIds(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_CONNECTIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((id): id is string => typeof id === "string")
          .slice(0, MAX_RECENT_CONNECTIONS);
      }
    }
  } catch {
    // ignore
  }
  return [];
}

function saveRecentConnectionIds(ids: string[]) {
  try {
    window.localStorage.setItem(
      RECENT_CONNECTIONS_KEY,
      JSON.stringify(ids.slice(0, MAX_RECENT_CONNECTIONS)),
    );
  } catch {
    // ignore
  }
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

  // Database switches are serialized and sequence-stamped: `use_database` is
  // stateful on the backend, so a fast workspace/database toggle (A→B) must
  // never interleave — a superseded switch must not overwrite `tables` after
  // the newer one finished, and the backend USE must land in click order.
  let databaseSwitchSequence = 0;
  let databaseSwitchQueue: Promise<void> = Promise.resolve();
  /** (connectionId, database) of the last fully completed switch; enables the
   *  redundant-switch skip below without re-fetching metadata. */
  let lastCompletedDatabaseSwitchKey: string | null = null;

  // In-flight connect tracking so the connecting screen's Cancel button can
  // abort the backend attempt (cancel_connection_attempt) and turn any
  // late-resolving connect into a no-op instead of yanking the user back into
  // the workspace after they left for the launcher.
  let connectAttemptToken = 0;
  let activeConnectRequestId: string | null = null;

  /**
   * True when a connect attempt targets the connection+database whose
   * metadata is already loaded and displayed — reconnecting to it may keep
   * the tables/schema objects instead of blanking them mid-reconnect.
   */
  const reconnectTargetsShownMetadata = (targetId: string, database: string | null | undefined) =>
    get().activeConnectionId === targetId &&
    Boolean(database) &&
    get().currentDatabase === database;

  const markConnected = (
    connectionId: string,
    database: string | null | undefined,
    connectionsPatch?: { connections: ConnectionConfig[] },
    options?: { keepExistingMetadata?: boolean },
  ) => {
    const connectedIds = new Set(get().connectedIds);
    connectedIds.add(connectionId);
    // Reconnecting to the database whose metadata is already on screen keeps
    // tables/schemaObjects (no empty flash, no redundant refetch); every
    // other connect drops them so metadata from another connection/database
    // is never presented under the new scope.
    const keepExistingMetadata =
      options?.keepExistingMetadata === true &&
      Boolean(database) &&
      get().activeConnectionId === connectionId &&
      get().currentDatabase === database;
    if (keepExistingMetadata && typeof database === "string") {
      lastCompletedDatabaseSwitchKey = metadataFetchKey(connectionId, database);
    }
    // Successful connect → front of the recents list (deduped, capped).
    const recentConnectionIds = [
      connectionId,
      ...get().recentConnectionIds.filter((id) => id !== connectionId),
    ].slice(0, MAX_RECENT_CONNECTIONS);
    saveRecentConnectionIds(recentConnectionIds);
    set({
      ...(connectionsPatch ?? {}),
      connectedIds,
      recentConnectionIds,
      activeConnectionId: connectionId,
      currentDatabase: database ?? null,
      ...(keepExistingMetadata ? {} : { schemaObjects: [], tables: [] }),
      connectError: null,
      isConnecting: false,
    });
  };

  const restoreOrClearOnConnectError = (
    error: unknown,
    targetId: string,
    previousState: ConnectSnapshot,
  ) => {
    if (get().activeConnectionId === targetId) {
      set({ ...previousState, isConnecting: false });
    } else {
      set({ isConnecting: false });
    }
    const details = parseConnectionError(error);
    useGlobalErrorStore
      .getState()
      .setError(
        `Connection to target failed: ${details.message}${details.hint ? ` ${details.hint}` : ""}`,
      );
    throw error;
  };

  const loadMetadataAfterConnect = (connectionId: string, database: string | null | undefined) => {
    if (database) {
      void get().fetchDatabases(connectionId);
      void get().fetchTables(connectionId, database);
      void get().fetchSchemaObjects(connectionId, database);
      return;
    }
    // Connected without a database (e.g. SQL Server with blank CSDL): fall
    // back to the first user database so the workspace still loads tables and
    // the AI assistant has schema context, instead of an empty catalog.
    void (async () => {
      await get().fetchDatabases(connectionId);
      const databases = get().databases;
      const firstUserDatabase = databases.find(
        (item) => !SYSTEM_DATABASE_NAMES.has(item.name.toLowerCase()),
      );
      const fallbackDatabase = firstUserDatabase?.name ?? databases[0]?.name;
      if (fallbackDatabase) {
        await get().switchDatabase(connectionId, fallbackDatabase);
      }
    })();
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
    recentConnectionIds: loadRecentConnectionIds(),
    isConnecting: false,
    isLoadingDatabases: false,
    isSwitchingDatabase: false,
    isLoadingTables: false,
    isLoadingSchemaObjects: false,
    connectError: null,

    clearConnectionError: () => set({ connectError: null }),

    // Abort the in-flight connect: bump the attempt token (so the pending
    // connect's resolve/reject can no longer flip the store into a connected or
    // error state), best-effort cancel the backend attempt, and stop the
    // connecting spinner. The caller (Cancel button) navigates to the launcher.
    cancelConnectionAttempt: () => {
      connectAttemptToken += 1;
      const requestId = activeConnectRequestId;
      activeConnectRequestId = null;
      if (requestId) {
        void invokeMutation("cancel_connection_attempt", { requestId }).catch(() => {});
      }
      set({ isConnecting: false, connectError: null });
    },

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
        set({
          connections: applyConnectionAssignments(connections.map(sanitizeConnectionConfig)),
        });
      } catch (error) {
        useGlobalErrorStore.getState().setError(`Failed to load connections: ${error}`);
      }
    },

    connectToDatabase: async (config) => {
      if (get().isConnecting) return;
      const previousState = snapshotForRestore();
      const normalizedConfig = resolveConnectionConfig(config);
      const keepsExistingMetadata = reconnectTargetsShownMetadata(
        normalizedConfig.id,
        normalizedConfig.database,
      );
      set({
        isConnecting: true,
        activeConnectionId: normalizedConfig.id,
        currentDatabase: normalizedConfig.database ?? null,
        ...(keepsExistingMetadata ? {} : { schemaObjects: [], tables: [] }),
      });

      const attemptToken = ++connectAttemptToken;
      try {
        const connections = get().connections;
        const requestId = crypto.randomUUID();
        activeConnectRequestId = requestId;
        await invokeWithTimeout(
          "connect_database",
          { config: normalizedConfig, requestId },
          FRONTEND_TIMEOUTS.connection,
          "Connecting to database",
          {
            onTimeout: () => invokeMutation("cancel_connection_attempt", { requestId }),
          },
        );
        // Cancelled while awaiting the backend? Do not finalize the connection.
        if (connectAttemptToken !== attemptToken) return;
        invalidateConnectionCapabilities(normalizedConfig.id);

        const savedConfig = sanitizeConnectionConfig(normalizedConfig);
        markConnected(
          normalizedConfig.id,
          normalizedConfig.database,
          {
            connections: connections.some((item) => item.id === normalizedConfig.id)
              ? connections.map((item) => (item.id === normalizedConfig.id ? savedConfig : item))
              : [...connections, savedConfig],
          },
          { keepExistingMetadata: keepsExistingMetadata },
        );

        await executeStartupCommands(normalizedConfig.id, normalizedConfig.startupCommands ?? "");
        loadMetadataAfterConnect(normalizedConfig.id, normalizedConfig.database);
      } catch (error) {
        // A cancelled attempt must not surface an error or bounce to the launcher.
        if (connectAttemptToken !== attemptToken) return;
        restoreOrClearOnConnectError(error, normalizedConfig.id, previousState);
      }
    },

    connectSavedConnection: async (connectionId) => {
      if (get().isConnecting) return;
      const connection = get().connections.find((item) => item.id === connectionId);
      const keepsExistingMetadata = reconnectTargetsShownMetadata(
        connectionId,
        connection?.database,
      );
      set({
        isConnecting: true,
        activeConnectionId: connectionId,
        currentDatabase: connection?.database ?? null,
        connectError: null,
        ...(keepsExistingMetadata ? {} : { schemaObjects: [], tables: [] }),
      });

      const attemptToken = ++connectAttemptToken;
      try {
        const requestId = crypto.randomUUID();
        activeConnectRequestId = requestId;
        await invokeWithTimeout(
          "connect_saved_connection",
          { connectionId, requestId },
          FRONTEND_TIMEOUTS.connection,
          "Connecting to database",
          {
            onTimeout: () => invokeMutation("cancel_connection_attempt", { requestId }),
          },
        );
        // Cancelled while awaiting the backend? Do not finalize the connection.
        if (connectAttemptToken !== attemptToken) return;
        invalidateConnectionCapabilities(connectionId);
        markConnected(connectionId, connection?.database, undefined, {
          keepExistingMetadata: keepsExistingMetadata,
        });

        await executeStartupCommands(connectionId, connection?.startupCommands ?? "");
        loadMetadataAfterConnect(connectionId, connection?.database);
      } catch (error) {
        // A failed saved-connection attempt keeps the SAME connecting screen
        // mounted and flips it to an in-place error (message + Try Again + Go to
        // Launcher) instead of bouncing back to the launcher with a detached
        // error bar. The failed target stays as `activeConnectionId` (it is NOT
        // added to `connectedIds`), so <WorkspaceConnecting> keeps rendering and
        // simply swaps its skeleton for the error + recovery actions. We do not
        // publish to the global error store here to avoid a second, redundant
        // error surface behind the overlay.
        // A cancelled attempt must not surface an error screen.
        if (connectAttemptToken !== attemptToken) return;
        const details = parseConnectionError(error);
        set({
          isConnecting: false,
          activeConnectionId: connectionId,
          connectError: { id: connectionId, ...details },
        });
      }
    },

    disconnectFromDatabase: async (connectionId, options) => {
      try {
        await invokeMutation("disconnect_database", { connectionId });
        invalidateConnectionCapabilities(connectionId);
        set(disconnectedPatch(get(), connectionId));
        if (!options?.keepTabs) {
          useUIStore.getState().removeTabsForConnection(connectionId);
        }
        // Tell any open profiler (including the detached native window, which does
        // not share this store) that the session is gone so it closes itself.
        void notifyProfilerConnectionClosed(connectionId);
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
          onTimeout: () => invokeMutation("cancel_connection_attempt", { requestId }),
        },
      );
    },
    deleteSavedConnection: async (connectionId) => {
      try {
        await invokeMutation("delete_saved_connection", { connectionId });
        // A deleted connection must not linger in the palette's Recent list.
        const recentConnectionIds = get().recentConnectionIds.filter((id) => id !== connectionId);
        saveRecentConnectionIds(recentConnectionIds);
        set({
          connections: get().connections.filter((connection) => connection.id !== connectionId),
          recentConnectionIds,
        });
        useUIStore.getState().removeTabsForConnection(connectionId);
      } catch (error) {
        useGlobalErrorStore.getState().setError(`Delete failed: ${error}`);
      }
    },

    renameSavedConnection: async (connectionId, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      await invokeMutation("rename_saved_connection", {
        connectionId,
        name: trimmed,
      });
      set({
        connections: get().connections.map((connection) =>
          connection.id === connectionId ? { ...connection, name: trimmed } : connection,
        ),
      });
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
        });
        useGlobalErrorStore.getState().setError(message);
      }
    },

    switchDatabase: (connectionId, database) => {
      const requestSequence = ++databaseSwitchSequence;
      const isLatestRequest = () => requestSequence === databaseSwitchSequence;
      const completedKeyFor = () => metadataFetchKey(connectionId, database);

      const run = databaseSwitchQueue.then(async () => {
        // Superseded by a newer switch (rapid workspace/database toggling) or the
        // connection is gone: do not run `use_database` nor touch any state.
        if (!isLatestRequest() || get().activeConnectionId !== connectionId) return;
        // Redundant switch: the connection already sits on this database with a
        // fully completed metadata load — skip the backend round-trip entirely.
        if (
          get().currentDatabase === database &&
          lastCompletedDatabaseSwitchKey === completedKeyFor()
        ) {
          return;
        }
        set({ isSwitchingDatabase: true });
        try {
          await invokeMutation("use_database", { connectionId, database });
          if (!isLatestRequest()) return;
          set({ currentDatabase: database, schemaObjects: [], isSwitchingDatabase: false });
          useUIStore.getState().removeTabsForStaleCatalog(connectionId, database);
          await Promise.all([
            get().fetchTables(connectionId, database),
            get().fetchSchemaObjects(connectionId, database),
          ]);
          if (isLatestRequest()) {
            lastCompletedDatabaseSwitchKey = completedKeyFor();
          }
        } catch (error) {
          if (!isLatestRequest()) return;
          set({
            isSwitchingDatabase: false,
          });
          useGlobalErrorStore.getState().setError(`Failed to switch database: ${error}`);
        }
      });
      // Keep the queue alive even when a switch fails.
      databaseSwitchQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },

    fetchTables: async (connectionId, database) =>
      runWithInFlight(inFlightTableFetches, metadataFetchKey(connectionId, database), async () => {
        const targetDatabase = database ?? get().currentDatabase ?? null;
        set({ isLoadingTables: true });
        try {
          const tables = await getOrLoadSchemaTables(
            { connectionId, database: targetDatabase ?? undefined },
            () =>
              invokeAIWorkspaceToolWithTimeout(
                "list_tables",
                { connectionId, database: targetDatabase || null },
                FRONTEND_TIMEOUTS.metadata,
                "Listing tables",
              ),
          );
          // Staleness guard: drop results that belong to a database the user has
          // already navigated away from (a slow or error-retried fetch overtaken
          // by a switch). Otherwise the header shows one DB while the tree holds
          // another DB's tables.
          const current = get();
          if (
            current.activeConnectionId !== connectionId ||
            current.currentDatabase !== targetDatabase
          ) {
            return;
          }
          set({ tables, isLoadingTables: false });
        } catch (error) {
          const current = get();
          const stillRelevant =
            current.activeConnectionId === connectionId &&
            current.currentDatabase === targetDatabase;
          set({
            isLoadingTables: false,
          });
          if (stillRelevant) {
            useGlobalErrorStore.getState().setError(`Failed to list tables: ${error}`);
          }
        }
      }),

    fetchSchemaObjects: async (connectionId, database) =>
      runWithInFlight(
        inFlightSchemaObjectFetches,
        metadataFetchKey(connectionId, database),
        async () => {
          const targetDatabase = database ?? get().currentDatabase ?? null;
          set({ isLoadingSchemaObjects: true });
          try {
            const schemaObjects = await getOrLoadSchemaObjects(
              { connectionId, database: targetDatabase ?? undefined },
              () =>
                invokeWithTimeout<SchemaObjectInfo[]>(
                  "list_schema_objects",
                  { connectionId, database: targetDatabase || null },
                  FRONTEND_TIMEOUTS.metadata,
                  "Listing schema objects",
                ),
            );
            // Same staleness guard as fetchTables: a late response for a database
            // the user already left must never overwrite the current tree.
            const current = get();
            if (
              current.activeConnectionId !== connectionId ||
              current.currentDatabase !== targetDatabase
            ) {
              return;
            }
            set({ schemaObjects, isLoadingSchemaObjects: false });
          } catch (error) {
            const current = get();
            const stillRelevant =
              current.activeConnectionId === connectionId &&
              current.currentDatabase === targetDatabase;
            set({
              isLoadingSchemaObjects: false,
            });
            if (stillRelevant) {
              useGlobalErrorStore.getState().setError(`Failed to list schema objects: ${error}`);
            }
          }
        },
      ),

    invalidateSchemaMetadata: (connectionId, database) => {
      invalidateSchemaCache(connectionId, database);

      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("schema-cache-invalidated", { detail: { connectionId, database } }),
        );
      }

      const state = get();
      const activeDatabase = state.currentDatabase ?? undefined;
      if (
        state.activeConnectionId === connectionId &&
        (database === undefined || database === activeDatabase)
      ) {
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

    createSampleDatabase: async () => {
      const config = await invokeMutation<ConnectionConfig>("create_sample_database", {});
      const sanitized = sanitizeConnectionConfig(config);
      const connections = get().connections;
      set({
        connections: applyConnectionAssignments(
          connections.some((item) => item.id === sanitized.id)
            ? connections.map((item) => (item.id === sanitized.id ? sanitized : item))
            : [...connections, sanitized],
        ),
      });
      return sanitized;
    },
  };
});
