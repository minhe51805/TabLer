import { create } from "zustand";
import { invokeMutation } from "../utils/tauri-utils";
import type { QueryHistoryEntry } from "../types";
import { EventCenter } from "./event-center";

interface QueryHistoryState {
  entries: QueryHistoryEntry[];
  isLoading: boolean;

  loadHistory: (connectionId?: string, search?: string, limit?: number) => Promise<void>;
  deleteEntry: (entryId: number, connectionId?: string) => Promise<void>;
  deleteEntries: (entryIds: number[], connectionId?: string) => Promise<number>;
  clearHistory: (connectionId?: string) => Promise<number>;
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

export const useQueryHistoryStore = create<QueryHistoryState>((set, get) => ({
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

  deleteEntry: async (entryId, connectionId) => {
    await get().deleteEntries([entryId], connectionId);
  },

  deleteEntries: async (entryIds, connectionId) => {
    if (!entryIds.length) return 0;
    try {
      const removed = await invokeMutation<number>("delete_query_history_entries", { entryIds });
      if (removed <= 0) return 0;
      EventCenter.emit("query-history-updated", { connectionId });
      set((state) => ({
        entries: state.entries.filter((entry) => !(typeof entry.id === "number" && entryIds.includes(entry.id))),
      }));
      return removed;
    } catch (e) {
      console.error("Failed to delete query history entries:", e);
      return 0;
    }
  },

  clearHistory: async (connectionId) => {
    try {
      const removed = await invokeMutation<number>("clear_query_history", {
        connectionId: connectionId ?? null,
      });
      EventCenter.emit("query-history-updated", { connectionId });
      set((state) => ({
        entries: connectionId
          ? state.entries.filter((entry) => entry.connection_id !== connectionId)
          : [],
      }));
      return removed;
    } catch (e) {
      console.error("Failed to clear query history:", e);
      return 0;
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
      const id = await invokeMutation<number>("save_query_history", { entry });
      EventCenter.emit("query-history-updated", { connectionId });
      set((state) => ({
        entries: [
          { ...entry, id },
          ...state.entries.filter((existing) => existing.id !== id),
        ],
      }));
    } catch (e) {
      console.error("Failed to save query history entry:", e);
    }
  },
}));
