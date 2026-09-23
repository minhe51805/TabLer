/**
 * Query schedules store — CRUD proxy to the Rust scheduler commands plus
 * the `schedule-fired` event bridge for run notifications.
 */

import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invokeMutation } from "../utils/tauri-utils";
import { emitAppToast } from "../utils/app-toast";
import { getCurrentAppLanguage, translateLanguage } from "../i18n";
import { useAgentScheduleStore } from "./agent-schedule-store";
import { getScheduleCopy } from "../components/QuerySchedules/schedule-copy";

export interface QuerySchedule {
  id: string;
  name: string;
  /**
   * `sql` (default): the backend runs the statement on its own schedule.
   * `agent`: the backend only dispatches a trigger and the in-app agent runs
   * the `prompt` READ-ONLY while the app is open.
   */
  kind: "sql" | "agent";
  /** Statement for a SQL schedule; empty for an agent task. */
  sql: string;
  /** Natural-language task for an agent schedule; absent for SQL. */
  prompt?: string | null;
  connectionId?: string | null;
  database?: string | null;
  intervalSeconds: number;
  enabled: boolean;
  lastRanAt?: number | null;
  /**
   * `dispatched` = handed to the app, outcome not reported back yet.
   * `needs_human` = the run stopped short because only a person may do what it
   * reached for — deliberately distinct from both `ok` and `error`.
   * `missed` = one or more occurrences elapsed while the app was closed.
   */
  lastStatus?: "ok" | "error" | "needs_human" | "dispatched" | "missed" | null;
  lastRows?: number | null;
  lastError?: string | null;
  /** Short report from the last completed agent run. */
  lastSummary?: string | null;
  /**
   * What to do about occurrences missed while the app was closed:
   * `skip` (default) resumes on the next boundary; `run_once` fires a single
   * catch-up run on the next boot.
   */
  catchUpPolicy?: "skip" | "run_once";
  /** Occurrences missed while the app was closed, until acknowledged. */
  missedCount?: number;
  /**
   * Agent tasks only: explicit opt-in letting the task read live data and
   * send it to the AI provider. Absent/false keeps the task metadata-only.
   */
  allowDataRead?: boolean;
  /** Explicit next-due override set when missed occurrences were skipped. */
  nextDueAt?: number | null;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleFiredPayload {
  scheduleId: string;
  name: string;
  kind?: "sql" | "agent";
  /** Present for SQL runs; a dispatch carries only `dispatched`. */
  status?: "ok" | "error" | "needs_human" | "dispatched";
  /** Agent dispatch only: the schedule's data-read opt-in. */
  allowDataRead?: boolean;
  rows?: number | null;
  error?: string | null;
  /** Agent dispatch only: the run's scope, so a mismatched one is never run. */
  connectionId?: string | null;
  database?: string | null;
  prompt?: string | null;
}

interface QuerySchedulesState {
  schedules: QuerySchedule[];
  isLoading: boolean;
  loadSchedules: () => Promise<void>;
  saveSchedule: (params: {
    id?: string;
    name: string;
    kind?: "sql" | "agent";
    sql?: string;
    prompt?: string | null;
    connectionId?: string | null;
    database?: string | null;
    intervalSeconds: number;
    enabled: boolean;
    allowDataRead?: boolean;
    catchUpPolicy?: "skip" | "run_once";
  }) => Promise<QuerySchedule>;
  deleteSchedule: (id: string) => Promise<void>;
  /**
   * Mirrors an agent run outcome this session reported back, so the open panel
   * shows the outcome without a reload. Only call it when the backend confirmed
   * the report — otherwise the row is still `dispatched`.
   */
  applyAgentRunOutcome: (params: {
    scheduleId: string;
    status: "ok" | "needs_human" | "error";
    rows?: number | null;
    error?: string | null;
    summary?: string | null;
  }) => void;
  /** Idempotent event bridge — attach once from the workspace shell. */
  attachScheduleEvents: () => () => void;
  /**
   * Dismisses the "runs missed while the app was closed" badge: clears every
   * schedule's `missedCount` in the store and on disk.
   */
  acknowledgeMissedRuns: () => Promise<void>;
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
      // A silent list failure leaves the panel on a stale/empty view; surface
      // it so the user knows the schedules they see may not be current.
      emitAppToast({
        title: getScheduleCopy(getCurrentAppLanguage()).loadFailed,
        description: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
      set({ isLoading: false });
    }
  },

  saveSchedule: async ({
    id,
    name,
    kind,
    sql,
    prompt,
    connectionId,
    database,
    intervalSeconds,
    enabled,
    allowDataRead,
    catchUpPolicy,
  }) => {
    const saved = await invokeMutation<QuerySchedule>("save_query_schedule", {
      id: id ?? null,
      name,
      // Defaulting to `sql` keeps every existing caller (favorites hand-off)
      // working unchanged.
      kind: kind ?? "sql",
      allowDataRead: allowDataRead ?? false,
      sql: sql ?? "",
      prompt: prompt ?? null,
      connectionId: connectionId ?? null,
      database: database ?? null,
      intervalSeconds: Math.max(60, Math.round(intervalSeconds)),
      enabled,
      catchUpPolicy: catchUpPolicy ?? "skip",
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
    // A deleted schedule cannot report an outcome; dropping its queued task
    // keeps the queue from running work whose row no longer exists.
    useAgentScheduleStore.getState().dropAgentTask(id);
  },

  applyAgentRunOutcome: ({ scheduleId, status, rows, error, summary }) => {
    set((state) => ({
      schedules: state.schedules.map((schedule) =>
        schedule.id === scheduleId
          ? {
              ...schedule,
              lastStatus: status,
              lastRows: rows ?? null,
              lastError: error ?? null,
              lastSummary: summary ?? null,
              lastRanAt: Date.now(),
            }
          : schedule,
      ),
    }));
  },

  attachScheduleEvents: () => {
    if (eventsAttached) return () => {};
    eventsAttached = true;
    const unlisteners: UnlistenFn[] = [];
    // Boot reconciliation reports occurrences that elapsed while the app was
    // closed. Refresh the list so `missedCount`/`missed` statuses land, and
    // surface the count as a toast — the panel badge carries the detail.
    void listen<{ missedRuns: number }>("schedules-missed", (event) => {
      void useQuerySchedulesStore.getState().loadSchedules();
      emitAppToast({
        title: getScheduleCopy(getCurrentAppLanguage()).missedToast(event.payload.missedRuns),
        tone: "info",
      });
    })
      .then((cleanup) => unlisteners.push(cleanup))
      .catch(() => {
        // Browser-only tests and previews do not expose Tauri's event bridge.
      });
    void listen<ScheduleFiredPayload>("schedule-fired", (event) => {
      const fired = event.payload;
      // Agent tasks are dispatched, never executed by the backend: the event is
      // a hand-off, and only a run outcome can settle the row.
      if (fired.kind === "agent" || fired.status === "dispatched") {
        const prompt = typeof fired.prompt === "string" ? fired.prompt.trim() : "";
        set((state) => ({
          schedules: state.schedules.map((schedule) =>
            schedule.id === fired.scheduleId
              ? {
                  ...schedule,
                  lastStatus: "dispatched",
                  lastRows: null,
                  // The previous run's report and error must not survive into a
                  // dispatch that has no outcome yet. lastRanAt is NOT set here:
                  // it means "last actual run" and only applyAgentRunOutcome may
                  // write it (mirrors the backend's mark_agent_task_dispatched).
                  lastError: null,
                  lastSummary: null,
                }
              : schedule,
          ),
        }));
        if (!prompt) {
          // There is nothing to run — say so instead of queueing an empty task.
          emitAppToast({
            title: translateLanguage(getCurrentAppLanguage(), "schedules.agentEmptyTask", {
              name: fired.name,
            }),
            tone: "error",
          });
          return;
        }
        useAgentScheduleStore.getState().enqueueAgentTask({
          scheduleId: fired.scheduleId,
          name: fired.name,
          prompt,
          connectionId: fired.connectionId ?? null,
          database: fired.database ?? null,
          allowDataRead: fired.allowDataRead ?? false,
        });
        emitAppToast({
          title: translateLanguage(getCurrentAppLanguage(), "schedules.agentDispatched", {
            name: fired.name,
          }),
          description: translateLanguage(getCurrentAppLanguage(), "schedules.agentDispatchedHint"),
          tone: "info",
        });
        return;
      }
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
      const copy = getScheduleCopy(getCurrentAppLanguage());
      emitAppToast(
        fired.status === "ok"
          ? {
              title: copy.sqlRunOk(fired.name),
              description: copy.sqlRunOkRows(fired.rows ?? 0),
              tone: "success",
            }
          : {
              title: copy.sqlRunFailed(fired.name),
              description: fired.error ?? copy.unknownError,
              tone: "error",
            },
      );
    })
      .then((cleanup) => {
        unlisteners.push(cleanup);
      })
      .catch(() => {
        // Browser-only tests and previews do not expose Tauri's event bridge.
      });
    return () => {
      unlisteners.forEach((unlisten) => unlisten());
      eventsAttached = false;
    };
  },

  acknowledgeMissedRuns: async () => {
    await invokeMutation<number>("acknowledge_missed_schedule_runs", {});
    set((state) => ({
      schedules: state.schedules.map((schedule) =>
        schedule.missedCount ? { ...schedule, missedCount: 0 } : schedule,
      ),
    }));
  },
}));
