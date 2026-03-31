import { create } from "zustand";
import { invokeMutation } from "../utils/tauri-utils";
import type { QueryHistoryEntry } from "../types";

interface QueryHistoryState {
  entries: QueryHistoryEntry[];
  isLoading: boolean;

  loadHistory: (connectionId?: string, search?: string, limit?: number) => Promise<void>;
  saveEntry: (
    query: string,
    connectionId: string,
    duration: number,
    rowCount?: number,
    error?: string,
    database?: string
  ) => Promise<void>;
}

const DEFAULT_LIMIT = 500;

export const useQueryHistoryStore = create<QueryHistoryState>((set) => ({
  entries: [],
  isLoading: false,

  loadHistory: async (connectionId, search, limit = DEFAULT_LIMIT) => {
    set({ isLoading: true });
    try {
      const entries = await invokeMutation<QueryHistoryEntry[]>("get_query_history", {
        connectionId: connectionId ?? null,
        search: search ?? null,
        limit,
      });
      set({ entries, isLoading: false });
    } catch (e) {
      console.error("Failed to load query history:", e);
      set({ isLoading: false });
    }
  },

  saveEntry: async (query, connectionId, duration, rowCount, error, database) => {
    try {
      const entry: QueryHistoryEntry = {
        connection_id: connectionId,
        query_text: query,
        executed_at: new Date().toISOString(),
        duration_ms: duration,
        row_count: rowCount,
        error: error ?? undefined,
        database: database ?? undefined,
      };
      await invokeMutation<number>("save_query_history", { entry });
    } catch (e) {
      console.error("Failed to save query history entry:", e);
    }
  },
}));
