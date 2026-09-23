import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "../ai-agent-action-requestor";
import { agentToolError, isRetryableAgentToolError } from "../agent-tool-executor-helpers";
import { useQuerySchedulesStore } from "../../../stores/query-schedules-store";
import type { AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "manage_schedule",
  handler: async (ctx, args) => {
    const action = typeof args?.action === "string" ? args.action.trim() : "";
    if (!["list", "create", "delete"].includes(action)) {
      return agentToolError('manage_schedule requires args.action: "list", "create", or "delete".');
    }
    const store = useQuerySchedulesStore.getState();
    // A superseded run must not write or delete schedules.
    if (ctx.requestId !== ctx.requestIdRef.current) {
      throw new Error(AI_REQUEST_REPLACED_MESSAGE);
    }
    try {
      if (action === "list") {
        await store.loadSchedules();
        const schedules = useQuerySchedulesStore.getState().schedules;
        if (schedules.length === 0) {
          return "No scheduled tasks exist yet.";
        }
        const lines = schedules.slice(0, 50).map((schedule) => {
          const scope = `connection=${schedule.connectionId ?? "any"} database=${schedule.database ?? "(none)"}`;
          const status = schedule.lastStatus ? ` lastStatus=${schedule.lastStatus}` : "";
          const enabled = schedule.enabled ? "enabled" : "disabled";
          return `- "${schedule.name}" [${schedule.kind}] id=${schedule.id} every ${schedule.intervalSeconds}s ${enabled} ${scope}${status}`;
        });
        return [`${schedules.length} scheduled task(s):`, ...lines].join("\n");
      }

      if (action === "create") {
        const name = typeof args?.name === "string" ? args.name.trim() : "";
        const kind = args?.kind === "sql" ? "sql" : "agent";
        const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
        const sql = typeof args?.sql === "string" ? args.sql.trim() : "";
        const database = typeof args?.database === "string" ? args.database.trim() : "";
        const intervalSeconds =
          typeof args?.intervalSeconds === "number" && Number.isFinite(args.intervalSeconds)
            ? Math.round(args.intervalSeconds)
            : 0;
        if (!name) {
          return agentToolError('manage_schedule "create" requires a non-empty args.name.');
        }
        if (kind === "agent" && !prompt) {
          return agentToolError(
            'manage_schedule "create" (kind agent) requires args.prompt — the recurring task the agent runs.',
          );
        }
        if (kind === "sql" && !sql) {
          return agentToolError(
            'manage_schedule "create" (kind sql) requires args.sql — the statement run on the interval.',
          );
        }
        // A null database is a wildcard: the schedule fires against whatever
        // database is active at run time. Always pin one.
        if (!database) {
          return agentToolError(
            'manage_schedule "create" requires args.database — a schedule without one runs against whatever database happens to be active. Pass the database the task is about (the current one if unsure).',
          );
        }
        if (!ctx.connectionId) {
          return agentToolError("manage_schedule requires an active connection.");
        }
        if (intervalSeconds < 60) {
          return agentToolError('manage_schedule "create" requires args.intervalSeconds >= 60.');
        }
        const saved = await store.saveSchedule({
          name,
          kind,
          sql: kind === "sql" ? sql : "",
          prompt: kind === "agent" ? prompt : null,
          connectionId: ctx.connectionId,
          database,
          intervalSeconds,
          enabled: args?.disabled !== true,
          // Agent-created schedules never get the data-read grant implicitly:
          // shipping rows to the provider unattended is a per-schedule opt-in
          // the user sets in the schedules panel.
          allowDataRead: false,
        });
        return `Created ${kind} schedule "${saved.name}" (id=${saved.id}): every ${saved.intervalSeconds}s on database "${saved.database}", ${saved.enabled ? "enabled" : "disabled"}. It fires while the app is open${kind === "agent" ? ", runs read-only, and stays schema-only until the user enables data reads in the schedules panel" : ""}.`;
      }

      // delete
      const id = typeof args?.id === "string" ? args.id.trim() : "";
      const name = typeof args?.name === "string" ? args.name.trim() : "";
      if (!id && !name) {
        return agentToolError(
          'manage_schedule "delete" needs args.id (from a list call) or args.name.',
        );
      }
      const schedules = useQuerySchedulesStore.getState().schedules;
      const target = id
        ? schedules.find((schedule) => schedule.id === id)
        : schedules.find((schedule) => schedule.name === name);
      if (!target) {
        return agentToolError(
          `No schedule matches ${id ? `id "${id}"` : `name "${name}"`}. Call manage_schedule with action "list" to see the exact ids.`,
        );
      }
      await store.deleteSchedule(target.id);
      return `Deleted schedule "${target.name}" (id=${target.id}).`;
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      return agentToolError(`manage_schedule failed. ${formatExecutionError(errorValue)}`, {
        retryable: isRetryableAgentToolError(errorValue),
      });
    }
  },
};
