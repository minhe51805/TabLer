/**
 * P10: runs queued scheduled agent tasks — the app side of the dispatch
 * handshake described in `stores/agent-schedule-store.ts`.
 *
 * A scheduled task is executed here, on the same code path a person's request
 * takes, but with `unattendedReadOnly` set. That flag is what makes the run
 * safe to leave alone: the write/memory/checkpoint tools are dropped from every
 * model payload, absent from the prompt catalog, and refused by the executor,
 * and the model is told to report findings instead of asking questions.
 *
 * Rules this runner deliberately follows:
 *
 *  * **One run at a time, never competing with the user.** A task is only
 *    claimed when no AI run is in flight and the panel is on the task's own
 *    connection/database. It never switches the workspace scope to fit a task.
 *  * **Nothing is quietly skipped.** A task that cannot start stays `waiting`
 *    in the queue (visible in the schedules panel) instead of being dropped or
 *    reported as a success.
 *  * **Findings are recorded, not written.** The run goes through the normal
 *    agent path, so P8 insights and P9 learning proposals are produced from its
 *    own trace; nothing is applied on the agent's authority.
 *  * **The outcome is the backend's.** The report is only mirrored into the local
 *    cache when `complete_agent_schedule_run` confirms it, so the UI can never
 *    show a result the store did not accept.
 *
 * Out of scope by design: running with the app closed. The agent loop is a React
 * hook, so a dispatch that arrives while the panel is unmounted waits for the
 * panel rather than being executed by the backend.
 */
import { useEffect, useRef, useState } from "react";
import { useAgentScheduleStore, type AgentTaskOutcome } from "../../../stores/agent-schedule-store";
import { useQuerySchedulesStore } from "../../../stores/query-schedules-store";
import { describeAgentRunFailure, describeFinishedAgentRun } from "../ai-agent-schedule-outcome";
import type { useAISlidePanel } from "./use-ai-slide-panel";

type AISlidePanelActions = ReturnType<typeof useAISlidePanel>;

export function useAgentScheduleRunner({
  generateAssist,
  isGenerating,
  connectionId,
  currentDatabase,
}: {
  generateAssist: AISlidePanelActions["generateAssist"];
  isGenerating: boolean;
  connectionId: string | null;
  currentDatabase: string | null;
}): void {
  const queuedRuns = useAgentScheduleStore((state) => state.runs);
  const claimRunnableTask = useAgentScheduleStore((state) => state.claimRunnableTask);
  const finishAgentTask = useAgentScheduleStore((state) => state.finishAgentTask);
  const applyAgentRunOutcome = useQuerySchedulesStore((state) => state.applyAgentRunOutcome);
  // Bumped after each finished task: the queue may still hold runnable work, and
  // claiming is the only way to find out.
  const [settleTick, setSettleTick] = useState(0);
  // Set synchronously before the first await, so a second effect pass (React
  // double-invoke, or the store update that marks the task `running`) can never
  // start a concurrent unattended run.
  const isRunningRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (isRunningRef.current || isGenerating) return;
    // With no active connection there is nothing to read: the task waits (and
    // stays visible as waiting) instead of failing on a missing scope.
    if (!connectionId) return;
    const task = claimRunnableTask({
      connectionId,
      database: currentDatabase,
      isBusy: isGenerating,
    });
    if (!task) return;
    isRunningRef.current = true;
    void (async () => {
      let outcome: AgentTaskOutcome;
      try {
        const result = await generateAssist(task.prompt, [], {
          interactionMode: "agent",
          // Nobody is present to answer a dialog, so data reads are gated by
          // the per-schedule opt-in the user set at creation time — a task
          // without it stays schema-only and never ships rows to the provider.
          // The destructive confirmation is never wired here: an unattended
          // run cannot reach a write at all.
          requestDataReadConsent: async () => task.allowDataRead,
          userPrompt: task.prompt,
          unattendedReadOnly: true,
        });
        // A run that was refused a tool it reached for reports `needs_human`,
        // never `ok`: it stopped short, and the refusal stays in the report.
        const report = describeFinishedAgentRun({
          response: result.rawResponse,
          blockedTools: result.unattendedBlockedTools,
        });
        outcome = {
          status: report.status,
          // Deliberately `null`: an unattended run may read many times, and a
          // row count would then be a number nobody measured.
          rows: null,
          error: null,
          summary: report.summary,
        };
      } catch (runError) {
        outcome = {
          status: "error",
          rows: null,
          error: describeAgentRunFailure(runError),
          summary: null,
        };
      }
      const reported = await finishAgentTask(task.scheduleId, outcome);
      if (reported) {
        // Only mirror what the backend accepted; otherwise the row is still
        // `dispatched` and must keep saying so.
        applyAgentRunOutcome({ scheduleId: task.scheduleId, ...outcome });
      }
      isRunningRef.current = false;
      if (isMountedRef.current) {
        setSettleTick((tick) => tick + 1);
      }
    })();
  }, [
    queuedRuns,
    settleTick,
    isGenerating,
    connectionId,
    currentDatabase,
    claimRunnableTask,
    finishAgentTask,
    applyAgentRunOutcome,
    generateAssist,
  ]);
}
