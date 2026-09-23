/**
 * Unattended agent task queue (P10).
 *
 * The Rust scheduler does not run agent tasks — it only *dispatches* them and
 * waits (`complete_agent_schedule_run`). This store is the app side of that
 * handshake:
 *
 *  * `enqueueAgentTask` receives a dispatch from the `schedule-fired` event.
 *  * `claimRunnableTask` hands at most one task to the AI panel, and only when
 *    the app is actually able to run it in the right scope — the schedule's
 *    connection and database must be the ones the panel is looking at, and no
 *    other AI run may be in flight. A task that cannot run stays `waiting` and
 *    is visible as such; it is never silently skipped and never reported as a
 *    success.
 *  * `finishAgentTask` reports the real outcome back to the schedule row and
 *    drops the task from the queue.
 *
 * In RAM on purpose: a queued task belongs to this app session. After a restart
 * the row still says `dispatched` (outcome unknown), which is the honest state —
 * resurrecting a queue from disk would claim work the app never did.
 *
 * The queue never switches the user's active connection or database: an
 * unattended task must not move the workspace out from under whoever is using
 * the app.
 */

import { create } from "zustand";
import { invokeMutation } from "../utils/tauri-utils";

/** Why a queued task has not started yet, for display. */
export type AgentTaskWaitReason = "connection" | "database" | "busy";

export interface AgentTaskRun {
  scheduleId: string;
  name: string;
  prompt: string;
  /** Scope the task must run in; `null` = whatever the panel is on. */
  connectionId: string | null;
  database: string | null;
  /** `waiting` = dispatched, not started yet. `running` = the agent is on it. */
  status: "waiting" | "running";
  /**
   * Per-schedule opt-in: the task may read live data and send it to the AI
   * provider. Without it the unattended run stays schema-only — a scheduled
   * task must never ship rows nobody granted it.
   */
  allowDataRead: boolean;
  dispatchedAt: number;
}

/** What a completed run reports back to the backend. */
export interface AgentTaskOutcome {
  /**
   * `ok` = the run answered; `needs_human` = it was refused something only a
   * person may do, so it stopped short; `error` = the run threw. `dispatched`
   * is absent on purpose — the scheduler owns that status, and a run must never
   * leave its own trigger looking unanswered.
   */
  status: "ok" | "needs_human" | "error";
  /** Row count when exactly one read produced one; never invented for a multi-read run. */
  rows?: number | null;
  error?: string | null;
  summary?: string | null;
}

interface AgentScheduleState {
  runs: AgentTaskRun[];
  /** Latest dispatch per schedule id; a duplicate of an in-flight task is ignored. */
  enqueueAgentTask: (task: {
    scheduleId: string;
    name: string;
    prompt: string;
    connectionId?: string | null;
    database?: string | null;
    allowDataRead?: boolean;
  }) => void;
  /**
   * Takes the next task that may run right now and marks it `running`.
   * Returns `null` when nothing is runnable, so the caller can simply try again
   * on the next render/tick.
   */
  claimRunnableTask: (context: {
    connectionId: string | null;
    database: string | null;
    isBusy: boolean;
  }) => AgentTaskRun | null;
  /**
   * Reports the outcome and removes the task. Resolves `true` only when the
   * backend accepted the report — a caller must not mirror an outcome the app
   * failed to record.
   */
  finishAgentTask: (scheduleId: string, outcome: AgentTaskOutcome) => Promise<boolean>;
  /** Drops a task without claiming a result (used when a run is abandoned). */
  dropAgentTask: (scheduleId: string) => void;
  clearAgentTasks: () => void;
}

/**
 * Whether a queued task matches the scope the panel is currently on. A task
 * pinned to a different connection or database waits instead (never a silent
 * cross-database run).
 *
 * A task with NO pinned database is a wildcard — but only over real databases:
 * it still requires an active database to run against, because "no database
 * selected" would silently execute the task on the connection's implicit
 * default, which is not a scope the task ever named.
 */
export function describeTaskWait(
  task: AgentTaskRun,
  context: { connectionId: string | null; database: string | null; isBusy: boolean },
): AgentTaskWaitReason | null {
  if (task.connectionId && task.connectionId !== context.connectionId) return "connection";
  if (task.database && task.database !== context.database) return "database";
  if (!task.database && !context.database) return "database";
  if (context.isBusy) return "busy";
  return null;
}

export const useAgentScheduleStore = create<AgentScheduleState>()((set, get) => ({
  runs: [],

  enqueueAgentTask: ({ scheduleId, name, prompt, connectionId, database, allowDataRead }) =>
    set((state) => {
      const existing = state.runs.find((run) => run.scheduleId === scheduleId);
      // A dispatch for a task that is already running is a repeat of the same
      // work (or a re-dispatch the app cannot answer) — ignore it rather than
      // running the same task twice.
      if (existing?.status === "running") return state;
      const entry: AgentTaskRun = {
        scheduleId,
        name,
        prompt,
        connectionId: connectionId ?? null,
        database: database ?? null,
        allowDataRead: allowDataRead === true,
        status: "waiting",
        dispatchedAt: Date.now(),
      };
      return {
        runs: existing
          ? state.runs.map((run) => (run.scheduleId === scheduleId ? entry : run))
          : [...state.runs, entry],
      };
    }),

  /**
   * Claims the first task that may run right now. The status flips to `running`
   * before this returns, so two callers (for example a React double-invoke)
   * can never run the same task twice.
   */
  claimRunnableTask: (context) => {
    const runnable = get().runs.find(
      (run) => run.status === "waiting" && describeTaskWait(run, context) === null,
    );
    if (!runnable) return null;
    const claimed: AgentTaskRun = { ...runnable, status: "running" };
    if (!claimed.database) {
      // Wildcard scope: the task runs on whatever database is active. Loud in
      // the console so a task that lands on the wrong database is diagnosable
      // instead of a silent surprise.
      console.warn(
        `[AgentSchedule] Task "${claimed.name}" has no pinned database; running it on the active database "${context.database}".`,
      );
    }
    set({
      runs: get().runs.map((run) => (run.scheduleId === claimed.scheduleId ? claimed : run)),
    });
    return claimed;
  },
  finishAgentTask: async (scheduleId, outcome) => {
    // Drop the task first: the queue must not keep a finished run alive if the
    // report fails, or the runner would try to claim it a second time.
    set((state) => ({ runs: state.runs.filter((run) => run.scheduleId !== scheduleId) }));
    try {
      await invokeMutation<void>("complete_agent_schedule_run", {
        scheduleId,
        status: outcome.status,
        rows: outcome.rows ?? null,
        error: outcome.error ?? null,
        summary: outcome.summary ?? null,
      });
      return true;
    } catch (error) {
      // The queue entry is already gone and the schedule row still says
      // `dispatched` — the honest state for an outcome nobody recorded.
      console.error("Failed to report the agent schedule outcome:", error);
      return false;
    }
  },

  dropAgentTask: (scheduleId) =>
    set((state) => ({ runs: state.runs.filter((run) => run.scheduleId !== scheduleId) })),

  clearAgentTasks: () => set({ runs: [] }),
}));
