import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionConfig,
  DatabaseInfo,
  TableInfo,
  Tab,
  QueryResult,
  TableCellUpdateRequest,
  TableStructure,
  AIProviderConfig,
} from "../types";

const connectionSignature = (c: ConnectionConfig) =>
  [
    c.db_type,
    (c.host || "").trim().toLowerCase(),
    c.port || "",
    (c.username || "").trim(),
    (c.database || "").trim().toLowerCase(),
    (c.file_path || "").trim().toLowerCase(),
  ].join("|");

const sanitizeConnectionConfig = (config: ConnectionConfig): ConnectionConfig => ({
  ...config,
  password: undefined,
});

interface AppState {
  connections: ConnectionConfig[];
  activeConnectionId: string | null;
  connectedIds: Set<string>;

  aiConfigs: AIProviderConfig[];
  aiKeyStatus: Record<string, boolean>;

  databases: DatabaseInfo[];
  currentDatabase: string | null;
  tables: TableInfo[];

  tabs: Tab[];
  activeTabId: string | null;

  isConnecting: boolean;
  isLoadingTables: boolean;
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
  countRows: (connectionId: string, table: string, database?: string) => Promise<number>;
  updateTableCell: (connectionId: string, request: TableCellUpdateRequest) => Promise<number>;

  addTab: (tab: Tab) => void;
  removeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTab: (tabId: string, updates: Partial<Tab>) => void;

  loadAIConfigs: () => Promise<void>;
  saveAIConfigs: (
    configs: AIProviderConfig[],
    apiKeyUpdates: Record<string, string>,
    clearedProviderIds: string[]
  ) => Promise<void>;
  askAI: (providerId: string, prompt: string, context: string) => Promise<string>;

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
  tabs: [],
  activeTabId: null,
  isConnecting: false,
  isLoadingTables: false,
  isExecutingQuery: false,
  error: null,

  aiConfigs: [],
  aiKeyStatus: {},

  loadSavedConnections: async () => {
    try {
      const connections = await invoke<ConnectionConfig[]>("get_saved_connections");
      set({ connections: connections.map(sanitizeConnectionConfig) });
    } catch (e) {
      set({ error: `Failed to load connections: ${e}` });
    }
  },

  loadAIConfigs: async () => {
    try {
      const [aiConfigs, aiKeyStatus] = await invoke<[AIProviderConfig[], Record<string, boolean>]>("get_ai_configs");
      set({ aiConfigs, aiKeyStatus });
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
      await invoke("save_ai_configs", { providers: configs, apiKeyUpdates, clearedProviderIds });
      await get().loadAIConfigs();
    } catch (e) {
      set({ error: `Failed to save AI configs: ${e}` });
      throw e;
    }
  },

  askAI: async (providerId: string, prompt: string, context: string) => {
    const config = get().aiConfigs.find(c => c.id === providerId);
    if (!config) throw new Error("AI Provider not found");

    try {
      const resp = await invoke<{ text: string; error?: string }>("ask_ai", {
        request: { prompt, context, provider_id: providerId }
      });
      if (resp.error) throw new Error(resp.error);
      return resp.text;
    } catch (e) {
      throw e;
    }
  },

  connectToDatabase: async (config: ConnectionConfig) => {
    if (get().isConnecting) return;

    set({ isConnecting: true, error: null });
    try {
      const connections = get().connections;
      const sameId = connections.find((c) => c.id === config.id);
      const sameTarget = connections.find(
        (c) => c.id !== config.id && connectionSignature(c) === connectionSignature(config)
      );

      const finalConnectionId = sameTarget?.id || config.id;
      const connectionRequest = { ...config, id: finalConnectionId };
      const finalConfig = sanitizeConnectionConfig({ ...config, id: finalConnectionId });

      await invoke("connect_database", { config: connectionRequest });

      const connectedIds = new Set(get().connectedIds);
      connectedIds.add(finalConnectionId);

      let newConnections = connections;
      if (sameId) {
        newConnections = connections.map((c) => (c.id === config.id ? finalConfig : c));
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
        isConnecting: false,
      });

      await get().fetchDatabases(finalConnectionId);
      if (config.database) {
        set({ currentDatabase: config.database });
        await get().fetchTables(finalConnectionId, config.database);
      }
    } catch (e) {
      set({ isConnecting: false, error: `Connection failed: ${e}` });
      throw e;
    }
  },

  connectSavedConnection: async (connectionId: string) => {
    if (get().isConnecting) return;

    set({ isConnecting: true, error: null });
    try {
      await invoke("connect_saved_connection", { connectionId });

      const connection = get().connections.find((item) => item.id === connectionId);
      const connectedIds = new Set(get().connectedIds);
      connectedIds.add(connectionId);

      set({
        connectedIds,
        activeConnectionId: connectionId,
        isConnecting: false,
      });

      await get().fetchDatabases(connectionId);
      if (connection?.database) {
        set({ currentDatabase: connection.database });
        await get().fetchTables(connectionId, connection.database);
      }
    } catch (e) {
      set({ isConnecting: false, error: `Connection failed: ${e}` });
      throw e;
    }
  },

  disconnectFromDatabase: async (connectionId: string) => {
    try {
      await invoke("disconnect_database", { connectionId });
      const connectedIds = new Set(get().connectedIds);
      connectedIds.delete(connectionId);

      const newState: Partial<AppState> = { connectedIds };
      if (get().activeConnectionId === connectionId) {
        newState.activeConnectionId = null;
        newState.databases = [];
        newState.tables = [];
        newState.currentDatabase = null;
      }

      set(newState as any);
    } catch (e) {
      set({ error: `Disconnect failed: ${e}` });
    }
  },

  testConnection: async (config: ConnectionConfig) => invoke<string>("test_connection", { config }),

  deleteSavedConnection: async (connectionId: string) => {
    try {
      await invoke("delete_saved_connection", { connectionId });
      set({ connections: get().connections.filter((c) => c.id !== connectionId) });
    } catch (e) {
      set({ error: `Delete failed: ${e}` });
    }
  },

  fetchDatabases: async (connectionId: string) => {
    try {
      const databases = await invoke<DatabaseInfo[]>("list_databases", { connectionId });
      set({ databases });
    } catch (e) {
      set({ error: `Failed to list databases: ${e}` });
    }
  },

  switchDatabase: async (connectionId: string, database: string) => {
    try {
      await invoke("use_database", { connectionId, database });
      set({ currentDatabase: database });
      await get().fetchTables(connectionId, database);
    } catch (e) {
      set({ error: `Failed to switch database: ${e}` });
    }
  },

  fetchTables: async (connectionId: string, database?: string) => {
    set({ isLoadingTables: true });
    try {
      const tables = await invoke<TableInfo[]>("list_tables", {
        connectionId,
        database: database || null,
      });
      set({ tables, isLoadingTables: false });
    } catch (e) {
      set({ isLoadingTables: false, error: `Failed to list tables: ${e}` });
    }
  },

  executeQuery: async (connectionId: string, sql: string) => {
    set({ isExecutingQuery: true });
    try {
      const result = await invoke<QueryResult>("execute_query", { connectionId, sql });
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
      const result = await invoke<QueryResult>("execute_sandboxed_query", {
        connectionId,
        statements,
      });
      set({ isExecutingQuery: false });
      return result;
    } catch (e) {
      set({ isExecutingQuery: false });
      throw e;
    }
  },

  getTableData: async (connectionId, table, opts = {}) => {
    return invoke<QueryResult>("get_table_data", {
      connectionId,
      table,
      database: opts.database || null,
      offset: opts.offset || 0,
      limit: opts.limit || 200,
      orderBy: opts.orderBy || null,
      orderDir: opts.orderDir || null,
      filter: opts.filter || null,
    });
  },

  getTableStructure: async (connectionId, table, database) =>
    invoke<TableStructure>("get_table_structure", {
      connectionId,
      table,
      database: database || null,
    }),

  countRows: async (connectionId, table, database) =>
    invoke<number>("count_table_rows", {
      connectionId,
      table,
      database: database || null,
    }),

  updateTableCell: async (connectionId, request) =>
    invoke<number>("update_table_cell", {
      connectionId,
      request: {
        ...request,
        database: request.database || null,
      },
    }),

  addTab: (tab: Tab) => {
    const tabs = get().tabs;
    const exists = tabs.find((t) => t.id === tab.id);
    if (exists) set({ activeTabId: tab.id });
    else set({ tabs: [...tabs, tab], activeTabId: tab.id });
  },

  removeTab: (tabId: string) => {
    const tabs = get().tabs.filter((t) => t.id !== tabId);
    const activeTabId =
      get().activeTabId === tabId ? (tabs.length > 0 ? tabs[tabs.length - 1].id : null) : get().activeTabId;
    set({ tabs, activeTabId });
  },

  setActiveTab: (tabId: string) => set({ activeTabId: tabId }),

  updateTab: (tabId: string, updates: Partial<Tab>) => {
    const tabs = get().tabs.map((t) => (t.id === tabId ? { ...t, ...updates } : t));
    set({ tabs });
  },

  setError: (error: string | null) => set({ error }),
  clearError: () => set({ error: null }),
}));
