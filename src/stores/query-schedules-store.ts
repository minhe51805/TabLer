/**
 * Query schedules store — CRUD proxy to the Rust scheduler commands plus
 * the `schedule-fired` event bridge for run notifications.
 */

import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invokeMutation } from "../utils/tauri-utils";
import { emitAppToast } from "../utils/app-toast";

export interface QuerySchedule {
  id: string;
  name: string;
  sql: string;
  connectionId?: string | null;
  database?: string | null;
  intervalSeconds: number;
  enabled: boolean;
  lastRanAt?: number | null;
  lastStatus?: "ok" | "error" | null;
  lastRows?: number | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleFiredPayload {
  scheduleId: string;
  name: string;
  status: "ok" | "error";
  rows?: number | null;
  error?: string | null;
}

interface QuerySchedulesState {
  schedules: QuerySchedule[];
  isLoading: boolean;
  loadSchedules: () => Promise<void>;
  saveSchedule: (params: {
    id?: string;
    name: string;
    sql: string;
    connectionId?: string | null;
    database?: string | null;
    intervalSeconds: number;
    enabled: boolean;
  }) => Promise<QuerySchedule>;
  deleteSchedule: (id: string) => Promise<void>;
  /** Idempotent event bridge — attach once from the workspace shell. */
  attachScheduleEvents: () => () => void;
}

let eventsAttached = false;

export const useQuerySchedulesStore = create<QuerySchedulesState>((set) => ({
  schedules: [],
  isLoading: false,

  loadSchedules: async () => {
    set({ isLoading: true });
    try {
      const schedules = await invokeMutation<QuerySchedule[]>("list_query_schedules", {});
      set({ schedules, isLoading: false });
    } catch (error) {
      console.error("Failed to load query schedules:", error);
      set({ isLoading: false });
    }
  },

  saveSchedule: async ({ id, name, sql, connectionId, database, intervalSeconds, enabled }) => {
    const saved = await invokeMutation<QuerySchedule>("save_query_schedule", {
      id: id ?? null,
      name,
      sql,
      connectionId: connectionId ?? null,
      database: database ?? null,
      intervalSeconds: Math.max(60, Math.round(intervalSeconds)),
      enabled,
    });
    set((state) => ({
      schedules: [saved, ...state.schedules.filter((schedule) => schedule.id !== saved.id)],
    }));
    return saved;
  },

  deleteSchedule: async (id) => {
    await invokeMutation<void>("delete_query_schedule", { id });
    set((state) => ({
      schedules: state.schedules.filter((schedule) => schedule.id !== id),
    }));
  },

  attachScheduleEvents: () => {
    if (eventsAttached) return () => {};
    eventsAttached = true;
    let unlisten: UnlistenFn | undefined;
    void listen<ScheduleFiredPayload>("schedule-fired", (event) => {
      const fired = event.payload;
      // Keep the cached run history in sync for the UI.
      set((state) => ({
        schedules: state.schedules.map((schedule) =>
          schedule.id === fired.scheduleId
            ? {
                ...schedule,
                lastStatus: fired.status,
                lastRows: fired.rows ?? null,
                lastError: fired.error ?? null,
                lastRanAt: Date.now(),
              }
            : schedule,
        ),
      }));
      emitAppToast(
        fired.status === "ok"
          ? {
              title: `Scheduled query ran: ${fired.name}`,
              description: `${fired.rows ?? 0} row(s) returned.`,
              tone: "success",
            }
          : {
              title: `Scheduled query failed: ${fired.name}`,
              description: fired.error ?? "Unknown error.",
              tone: "error",
            },
      );
    }).then((cleanup) => {
      unlisten = cleanup;
    }).catch(() => {
      // Browser-only tests and previews do not expose Tauri's event bridge.
    });
    return () => {
      unlisten?.();
      eventsAttached = false;
    };
  },
}));
