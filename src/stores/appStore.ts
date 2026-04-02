import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentAppLanguage } from "../i18n";

export { useConnectionStore } from "./connectionStore";
export { useQueryStore } from "./queryStore";
export { useAIStore } from "./aiStore";
export { useUIStore } from "./uiStore";

import type {
  ConnectionConfig,
  DatabaseInfo,
  TableInfo,
  SchemaObjectInfo,
  Tab,
  QueryResult,
  TableCellUpdateRequest,
  TableRowDeleteRequest,
  TableStructure,
  AIProviderConfig,
  AIConversationMessage,
  AIRequestIntent,
  AIRequestMode,
  ColumnDetail,
} from "../types";
import { getActiveAIProvider } from "../types";

const connectionSignature = (c: ConnectionConfig) =>
  [
    c.db_type,
    (c.host || "").trim().toLowerCase(),
    c.port || "",
    (c.username || "").trim(),
    (c.database || "").trim().toLowerCase(),
    (c.file_path || "").trim().toLowerCase(),
    JSON.stringify(
      Object.entries(c.additional_fields ?? {}).sort(([left], [right]) => left.localeCompare(right))
    ),
  ].join("|");

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

const FRONTEND_TIMEOUTS = {
  connection: 30_000,
  metadata: 15_000,
  tableData: 30_000,
  rowCount: 10_000,
  query: 300_000,
  ai: 60_000,
} as const;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function invokeWithTimeout<T>(
  command: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  label: string
) {
  return withTimeout(invoke<T>(command, args), timeoutMs, label);
}

function invokeMutation<T>(command: string, args: Record<string, unknown>) {
  return invoke<T>(command, args);
}

interface AppState {
  connections: ConnectionConfig[];
  activeConnectionId: string | null;
  connectedIds: Set<string>;

  aiConfigs: AIProviderConfig[];

  databases: DatabaseInfo[];
  currentDatabase: string | null;
  tables: TableInfo[];
  schemaObjects: SchemaObjectInfo[];

  tabs: Tab[];
  activeTabId: string | null;

  isConnecting: boolean;
  isLoadingDatabases: boolean;
  isSwitchingDatabase: boolean;
  isLoadingTables: boolean;
  isLoadingSchemaObjects: boolean;
  isExecutingQuery: boolean;

  error: string | null;

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
  createLocalDatabase: (
    config: ConnectionConfig,
    databaseName: string,
    bootstrapStatements?: string[]
  ) => Promise<string>;
  suggestSqliteDatabasePath: (databaseName: string) => Promise<string>;
  pickSqliteDatabasePath: (databaseName: string) => Promise<string | null>;

  executeQuery: (connectionId: string, sql: string) => Promise<QueryResult>;
  executeSandboxQuery: (connectionId: string, statements: string[]) => Promise<QueryResult>;
  getTableData: (
    connectionId: string,
    table: string,
    opts?: {
      database?: string;
      offset?: number;
      limit?: number;
      orderBy?: string;
      orderDir?: string;
      filter?: string;
    }
  ) => Promise<QueryResult>;
  getTableStructure: (
    connectionId: string,
    table: string,
    database?: string
  ) => Promise<TableStructure>;
  getTableColumnsPreview: (
    connectionId: string,
    table: string,
    database?: string
  ) => Promise<ColumnDetail[]>;
  countRows: (connectionId: string, table: string, database?: string) => Promise<number>;
  countTableNullValues: (
    connectionId: string,
    table: string,
    column: string,
    database?: string
  ) => Promise<number>;
  updateTableCell: (connectionId: string, request: TableCellUpdateRequest) => Promise<number>;
  deleteTableRows: (connectionId: string, request: TableRowDeleteRequest) => Promise<number>;
  insertTableRow: (connectionId: string, request: { table: string; database?: string; values: [string, unknown][] }) => Promise<number>;
  executeStructureStatements: (connectionId: string, statements: string[]) => Promise<number>;
  getForeignKeyLookupValues: (
    connectionId: string,
    table: string,
    column: string,
    search?: string,
  ) => Promise<Array<{ value: string | number; label: string }>>;

  addTab: (tab: Tab) => void;
  removeTab: (tabId: string) => void;
  clearTabs: () => void;
  setActiveTab: (tabId: string) => void;
  updateTab: (tabId: string, updates: Partial<Tab>) => void;

  loadAIConfigs: () => Promise<{
    aiConfigs: AIProviderConfig[];
    aiKeyStatus: Record<string, boolean>;
  }>;
  saveAIConfigs: (
    configs: AIProviderConfig[],
    apiKeyUpdates: Record<string, string>,
    clearedProviderIds: string[]
  ) => Promise<{
    aiConfigs: AIProviderConfig[];
    aiKeyStatus: Record<string, boolean>;
  }>;
  askAI: (
    prompt: string,
    context: string,
    mode?: AIRequestMode,
    intent?: AIRequestIntent,
    history?: AIConversationMessage[]
  ) => Promise<string>;

  setError: (error: string | null) => void;
  clearError: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  connections: [],
  activeConnectionId: null,
  connectedIds: new Set(),
  databases: [],
  currentDatabase: null,
  tables: [],
  schemaObjects: [],
  tabs: [],
  activeTabId: null,
  isConnecting: false,
  isLoadingDatabases: false,
  isSwitchingDatabase: false,
  isLoadingTables: false,
  isLoadingSchemaObjects: false,
  isExecutingQuery: false,
  error: null,

  aiConfigs: [],

  loadSavedConnections: async () => {
    try {
      const connections = await invokeWithTimeout<ConnectionConfig[]>(
        "get_saved_connections",
        {},
        FRONTEND_TIMEOUTS.metadata,
        "Loading saved connections"
      );
      set({ connections: connections.map(sanitizeConnectionConfig) });
    } catch (e) {
      set({ error: `Failed to load connections: ${e}` });
    }
  },

  loadAIConfigs: async () => {
    try {
      const [aiConfigs, aiKeyStatus] = await invokeWithTimeout<
        [AIProviderConfig[], Record<string, boolean>]
      >("get_ai_configs", {}, FRONTEND_TIMEOUTS.metadata, "Loading AI settings");
      set({ aiConfigs });
      return { aiConfigs, aiKeyStatus };
    } catch (e) {
      set({ error: `Failed to load AI configs: ${e}` });
      throw e;
    }
  },

  saveAIConfigs: async (
    configs: AIProviderConfig[],
    apiKeyUpdates: Record<string, string>,
    clearedProviderIds: string[]
  ) => {
    try {
      const [aiConfigs, aiKeyStatus] = await invokeMutation<
        [AIProviderConfig[], Record<string, boolean>]
      >(
        "save_ai_configs",
        { providers: configs, apiKeyUpdates, clearedProviderIds },
      );
      set({ aiConfigs });
      return { aiConfigs, aiKeyStatus };
    } catch (e) {
      set({ error: `Failed to save AI configs: ${e}` });
      throw e;
    }
  },

  askAI: async (prompt: string, context: string, mode = "panel", intent = "sql", history = []) => {
    const config = getActiveAIProvider(get().aiConfigs);
    if (!config) throw new Error("AI Provider not found");

    try {
      const resp = await invokeWithTimeout<{ text: string; error?: string }>(
        "ask_ai",
        {
          request: { prompt, context, mode, intent, language: getCurrentAppLanguage(), history },
        },
        FRONTEND_TIMEOUTS.ai,
        "AI request"
      );
      if (resp.error) throw new Error(resp.error);
      return resp.text;
    } catch (e) {
      throw e;
    }
  },

  connectToDatabase: async (config: ConnectionConfig) => {
    if (get().isConnecting) return;

    const previousState = {
      activeConnectionId: get().activeConnectionId,
      currentDatabase: get().currentDatabase,
      tables: get().tables,
      schemaObjects: get().schemaObjects,
    };

    try {
      const normalizedConfig = ensureConnectionName(config);
      const connections = get().connections;
      const sameId = connections.find((c) => c.id === normalizedConfig.id);
      const sameTarget = connections.find(
        (c) => c.id !== normalizedConfig.id && connectionSignature(c) === connectionSignature(normalizedConfig)
      );

      const finalConnectionId = sameTarget?.id || normalizedConfig.id;
      const connectionRequest = { ...normalizedConfig, id: finalConnectionId };
      const finalConfig = sanitizeConnectionConfig({ ...normalizedConfig, id: finalConnectionId });

      set({
        isConnecting: true,
        error: null,
        activeConnectionId: finalConnectionId,
        currentDatabase: normalizedConfig.database ?? null,
        schemaObjects: [],
        ...(normalizedConfig.database ? {} : { tables: [] }),
      });

      await invokeMutation(
        "connect_database",
        { config: connectionRequest },
      );

      const connectedIds = new Set(get().connectedIds);
      connectedIds.add(finalConnectionId);

      let newConnections = connections;
      if (sameId) {
        newConnections = connections.map((c) => (c.id === normalizedConfig.id ? finalConfig : c));
      } else if (sameTarget) {
        newConnections = connections.map((c) =>
          c.id === sameTarget.id ? finalConfig : c
        );
      } else {
        newConnections = [...connections, finalConfig];
      }

      set({
        connectedIds,
        activeConnectionId: finalConnectionId,
        connections: newConnections,
        currentDatabase: normalizedConfig.database ?? null,
        schemaObjects: [],
        ...(normalizedConfig.database ? {} : { tables: [] }),
        isConnecting: false,
      });

      void get().fetchDatabases(finalConnectionId);
      if (normalizedConfig.database) {
        set({ currentDatabase: normalizedConfig.database });
        void get().fetchTables(finalConnectionId, normalizedConfig.database);
      }
    } catch (e) {
      set({
        isConnecting: false,
        error: `Connection failed: ${e}`,
        activeConnectionId: previousState.activeConnectionId,
        currentDatabase: previousState.currentDatabase,
        tables: previousState.tables,
        schemaObjects: previousState.schemaObjects,
      });
      throw e;
    }
  },

  connectSavedConnection: async (connectionId: string) => {
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
      error: null,
      activeConnectionId: connectionId,
      currentDatabase: connection?.database ?? null,
      schemaObjects: [],
      ...(connection?.database ? {} : { tables: [] }),
    });

    try {
      await invokeMutation(
        "connect_saved_connection",
        { connectionId },
      );

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

      void get().fetchDatabases(connectionId);
      if (connection?.database) {
        set({ currentDatabase: connection.database });
        void get().fetchTables(connectionId, connection.database);
      }
    } catch (e) {
      set({
        isConnecting: false,
        error: `Connection failed: ${e}`,
        activeConnectionId: previousState.activeConnectionId,
        currentDatabase: previousState.currentDatabase,
        tables: previousState.tables,
        schemaObjects: previousState.schemaObjects,
      });
      throw e;
    }
  },

  disconnectFromDatabase: async (connectionId: string) => {
    try {
      await invokeMutation(
        "disconnect_database",
        { connectionId },
      );
      const connectedIds = new Set(get().connectedIds);
      connectedIds.delete(connectionId);
      const tabs = get().tabs.filter((tab) => tab.connectionId !== connectionId);
      const visibleTabs = tabs.filter((tab) => tab.type !== "metrics");
      const activeTabBelongsToDisconnectedConnection = get().tabs.some(
        (tab) => tab.id === get().activeTabId && tab.connectionId === connectionId,
      );

      const newState: Partial<AppState> = {
        connectedIds,
        tabs,
      };
      if (get().activeConnectionId === connectionId) {
        newState.activeConnectionId = null;
        newState.databases = [];
        newState.tables = [];
        newState.schemaObjects = [];
        newState.currentDatabase = null;
      }
      if (activeTabBelongsToDisconnectedConnection) {
        newState.activeTabId = visibleTabs.length > 0 ? visibleTabs[visibleTabs.length - 1].id : null;
      }

      set(newState);
    } catch (e) {
      set({ error: `Disconnect failed: ${e}` });
    }
  },

  testConnection: async (config: ConnectionConfig) =>
    invokeWithTimeout<string>(
      "test_connection",
      { config: ensureConnectionName(config) },
      FRONTEND_TIMEOUTS.connection,
      "Testing database connection"
    ),

  deleteSavedConnection: async (connectionId: string) => {
    try {
      await invokeMutation(
        "delete_saved_connection",
        { connectionId },
      );
      const tabs = get().tabs.filter((tab) => tab.connectionId !== connectionId);
      const visibleTabs = tabs.filter((tab) => tab.type !== "metrics");
      const activeTabBelongsToDeletedConnection = get().tabs.some(
        (tab) => tab.id === get().activeTabId && tab.connectionId === connectionId,
      );

      set({
        connections: get().connections.filter((c) => c.id !== connectionId),
        tabs,
        ...(activeTabBelongsToDeletedConnection
          ? {
              activeTabId: visibleTabs.length > 0 ? visibleTabs[visibleTabs.length - 1].id : null,
            }
          : {}),
      });
    } catch (e) {
      set({ error: `Delete failed: ${e}` });
    }
  },

  fetchDatabases: async (connectionId: string) => {
    set({ isLoadingDatabases: true });
    try {
      const databases = await invokeWithTimeout<DatabaseInfo[]>(
        "list_databases",
        { connectionId },
        FRONTEND_TIMEOUTS.metadata,
        "Listing databases"
      );
      set({ databases, isLoadingDatabases: false });
    } catch (e) {
      set({ isLoadingDatabases: false, error: `Failed to list databases: ${e}` });
    }
  },

  switchDatabase: async (connectionId: string, database: string) => {
    set({ isSwitchingDatabase: true });
    try {
      await invokeMutation(
        "use_database",
        { connectionId, database },
      );
      set({ currentDatabase: database, schemaObjects: [], isSwitchingDatabase: false });
      await get().fetchTables(connectionId, database);
    } catch (e) {
      set({ isSwitchingDatabase: false, error: `Failed to switch database: ${e}` });
    }
  },

  fetchTables: async (connectionId: string, database?: string) => {
    set({ isLoadingTables: true });
    try {
      const tables = await invokeWithTimeout<TableInfo[]>(
        "list_tables",
        {
          connectionId,
          database: database || null,
        },
        FRONTEND_TIMEOUTS.metadata,
        "Listing tables"
      );
      set({ tables, isLoadingTables: false });
    } catch (e) {
      set({ isLoadingTables: false, error: `Failed to list tables: ${e}` });
    }
  },

  fetchSchemaObjects: async (connectionId: string, database?: string) => {
    set({ isLoadingSchemaObjects: true });
    try {
      const schemaObjects = await invokeWithTimeout<SchemaObjectInfo[]>(
        "list_schema_objects",
        {
          connectionId,
          database: database || null,
        },
        FRONTEND_TIMEOUTS.metadata,
        "Listing schema objects"
      );
      set({ schemaObjects, isLoadingSchemaObjects: false });
    } catch (e) {
      set({ isLoadingSchemaObjects: false, error: `Failed to list schema objects: ${e}` });
    }
  },

  createLocalDatabase: async (config: ConnectionConfig, databaseName: string, bootstrapStatements = []) => {
    try {
      return await invokeMutation<string>(
        "create_local_database",
        {
          config: ensureConnectionName(config),
          databaseName,
          bootstrapStatements: bootstrapStatements.length > 0 ? bootstrapStatements : null,
        },
      );
    } catch (e) {
      set({ error: `Create database failed: ${e}` });
      throw e;
    }
  },

  suggestSqliteDatabasePath: async (databaseName: string) =>
    invokeWithTimeout<string>(
      "suggest_sqlite_database_path",
      { databaseName },
      FRONTEND_TIMEOUTS.metadata,
      "Preparing SQLite database location"
    ),

  pickSqliteDatabasePath: async (databaseName: string) =>
    invokeWithTimeout<string | null>(
      "pick_sqlite_database_path",
      { databaseName },
      FRONTEND_TIMEOUTS.metadata,
      "Opening SQLite save dialog"
    ),

  executeQuery: async (connectionId: string, sql: string) => {
    set({ isExecutingQuery: true });
    try {
      const result = await invokeMutation<QueryResult>(
        "execute_query",
        { connectionId, sql },
      );
      set({ isExecutingQuery: false });
      return result;
    } catch (e) {
      set({ isExecutingQuery: false });
      throw e;
    }
  },

  executeSandboxQuery: async (connectionId: string, statements: string[]) => {
    set({ isExecutingQuery: true });
    try {
      const result = await invokeMutation<QueryResult>(
        "execute_sandboxed_query",
        {
          connectionId,
          statements,
        },
      );
      set({ isExecutingQuery: false });
      return result;
    } catch (e) {
      set({ isExecutingQuery: false });
      throw e;
    }
  },

  getTableData: async (connectionId, table, opts = {}) => {
    return invokeWithTimeout<QueryResult>(
      "get_table_data",
      {
        connectionId,
        table,
        database: opts.database || null,
        offset: opts.offset || 0,
        limit: opts.limit || 100,
        orderBy: opts.orderBy || null,
        orderDir: opts.orderDir || null,
        filter: opts.filter || null,
      },
      FRONTEND_TIMEOUTS.tableData,
      "Loading table data"
    );
  },

  getTableStructure: async (connectionId, table, database) =>
    invokeWithTimeout<TableStructure>(
      "get_table_structure",
      {
        connectionId,
        table,
        database: database || null,
      },
      FRONTEND_TIMEOUTS.metadata,
      "Loading table structure"
    ),

  getTableColumnsPreview: async (connectionId, table, database) =>
    invokeWithTimeout<ColumnDetail[]>(
      "get_table_columns_preview",
      {
        connectionId,
        table,
        database: database || null,
      },
      FRONTEND_TIMEOUTS.metadata,
      "Loading table columns"
    ),

  countRows: async (connectionId, table, database) =>
    invokeWithTimeout<number>(
      "count_table_rows",
      {
        connectionId,
        table,
        database: database || null,
      },
      FRONTEND_TIMEOUTS.rowCount,
      "Counting table rows"
    ),

  countTableNullValues: async (connectionId, table, column, database) =>
    invokeWithTimeout<number>(
      "count_table_null_values",
      {
        connectionId,
        table,
        column,
        database: database || null,
      },
      FRONTEND_TIMEOUTS.rowCount,
      "Counting NULL values"
    ),

  updateTableCell: async (connectionId, request) =>
    invokeMutation<number>(
      "update_table_cell",
      {
        connectionId,
        request: {
          ...request,
          database: request.database || null,
        },
      },
    ),

  deleteTableRows: async (connectionId, request) =>
    invokeMutation<number>(
      "delete_table_rows",
      {
        connectionId,
        request: {
          ...request,
          database: request.database || null,
        },
      },
    ),

  insertTableRow: async (connectionId, request) =>
    invokeMutation<number>(
      "insert_table_row",
      {
        connectionId,
        request: {
          table: request.table,
          database: request.database || null,
          values: request.values,
        },
      },
    ),

  executeStructureStatements: async (connectionId, statements) =>
    invokeMutation<number>(
      "execute_structure_statements",
      {
        connectionId,
        statements,
      },
    ),

  getForeignKeyLookupValues: async (
    connectionId: string,
    table: string,
    column: string,
    search?: string,
  ) => {
    return invokeWithTimeout<Array<{ value: string | number; label: string }>>(
      "get_foreign_key_lookup_values",
      {
        connection_id: connectionId,
        referenced_table: table,
        referenced_column: column,
        search: search || null,
        limit: 1000,
      },
      FRONTEND_TIMEOUTS.tableData,
      "Loading FK lookup values",
    );
  },

  addTab: (tab: Tab) => {
    const tabs = get().tabs;
    const exists = tabs.find((t) => t.id === tab.id);
    if (exists) set({ activeTabId: tab.id });
    else set({ tabs: [...tabs, tab], activeTabId: tab.id });
  },

  removeTab: (tabId: string) => {
    const tabs = get().tabs.filter((t) => t.id !== tabId);
    const visibleTabs = tabs.filter((tab) => tab.type !== "metrics");
    const activeTabId =
      get().activeTabId === tabId
        ? visibleTabs.length > 0
          ? visibleTabs[visibleTabs.length - 1].id
          : null
        : get().activeTabId;
    set({ tabs, activeTabId });
  },

  clearTabs: () =>
    set((state) => ({
      tabs: state.tabs.filter((tab) => tab.type === "metrics"),
      activeTabId: null,
    })),

  setActiveTab: (tabId: string) => set({ activeTabId: tabId }),

  updateTab: (tabId: string, updates: Partial<Tab>) => {
    const tabs = get().tabs.map((t) => (t.id === tabId ? { ...t, ...updates } : t));
    set({ tabs });
  },

  setError: (error: string | null) => set({ error }),
  clearError: () => set({ error: null }),
}));
