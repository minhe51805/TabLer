import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "../ai-agent-action-requestor";
import { agentToolError, isRetryableAgentToolError } from "../agent-tool-executor-helpers";
import type { AgentToolModule } from "./shared";

/** Strip one layer of identifier quoting so "public"."orders" matches orders. */
function normalizeTableArg(value: string): string {
  return value
    .split(".")
    .map((segment) => segment.trim().replace(/^["'`[\]]+|["'`[\]]+$/g, ""))
    .filter(Boolean)
    .join(".")
    .toLowerCase();
}

export const tool: AgentToolModule = {
  name: "open_table_tab",
  handler: async (ctx, args) => {
    const table = typeof args?.table === "string" ? args.table.trim() : "";
    if (!table) {
      return agentToolError(
        "open_table_tab requires args.table — an exact name from list_tables.",
        {
          hint: ctx.tableNotFoundHint(table),
        },
      );
    }
    if (!ctx.connectionId) {
      return agentToolError("open_table_tab requires an active connection.");
    }
    if (typeof ctx.openTableTab !== "function") {
      return agentToolError("open_table_tab is unavailable in this context.");
    }
    // Fail closed on hallucinated tables: a tab for a name that is not in the
    // verified catalog would open an empty error view.
    if (ctx.availableSchemaTables.length > 0) {
      const wanted = normalizeTableArg(table);
      const matched = ctx.availableSchemaTables.some(
        (candidate) => normalizeTableArg(candidate) === wanted,
      );
      if (!matched) {
        return agentToolError(`open_table_tab: table "${table}" is not in the verified catalog.`, {
          hint: ctx.tableNotFoundHint(table),
        });
      }
    }
    // A superseded run must not open UI tabs.
    if (ctx.requestId !== ctx.requestIdRef.current) {
      throw new Error(AI_REQUEST_REPLACED_MESSAGE);
    }
    const database = typeof args?.database === "string" ? args.database.trim() : "";
    try {
      const opened = ctx.openTableTab({
        table,
        database: database || undefined,
      });
      if (!opened) {
        return agentToolError(
          `open_table_tab could not open a tab for "${table}" — no new tab was created.`,
          { retryable: true },
        );
      }
      return `Opened a data tab for "${table}"${database ? ` on database "${database}"` : ""}. The user can now browse and edit its rows in the workspace.`;
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      return agentToolError(`open_table_tab failed. ${formatExecutionError(errorValue)}`, {
        retryable: isRetryableAgentToolError(errorValue),
      });
    }
  },
};
