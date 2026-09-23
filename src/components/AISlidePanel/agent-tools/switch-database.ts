import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "../ai-agent-action-requestor";
import { buildWorkspaceTableIdentifier } from "../ai-agent-context";
import { agentToolError, isRetryableAgentToolError } from "../agent-tool-executor-helpers";
import { useConnectionStore } from "../../../stores/connectionStore";
import type { AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "switch_database",
  handler: async (ctx, args) => {
    const database = typeof args?.database === "string" ? args.database.trim() : "";
    if (!database) {
      return agentToolError("switch_database requires args.database — the exact database name.");
    }
    if (!ctx.connectionId) {
      return agentToolError("switch_database requires an active connection.");
    }
    const store = useConnectionStore.getState();
    if (store.activeConnectionId !== ctx.connectionId) {
      return agentToolError(
        "switch_database: the run's connection is no longer the active one — finish this run and retry.",
      );
    }
    // When the database list is loaded, fail fast on a name the server does
    // not have instead of letting use_database error opaquely. An empty list
    // means "not loaded yet", not "no databases" — skip the check then.
    if (store.databases.length > 0 && !store.databases.some((db) => db.name === database)) {
      return agentToolError(`switch_database: database "${database}" does not exist.`, {
        hint: `Available databases: ${store.databases.map((db) => db.name).join(", ")}.`,
      });
    }
    if (store.currentDatabase === database) {
      return `Already on database "${database}" — no switch needed.`;
    }
    // A superseded run must not change the app's active database.
    if (ctx.requestId !== ctx.requestIdRef.current) {
      throw new Error(AI_REQUEST_REPLACED_MESSAGE);
    }
    ctx.publishAgentProgress({
      action: "switch_database",
      message: `Switching to database "${database}".`,
    });
    try {
      await store.switchDatabase(ctx.connectionId, database);
      if (ctx.requestId !== ctx.requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }
      const next = useConnectionStore.getState();
      if (next.currentDatabase !== database) {
        return agentToolError(
          `switch_database did not land on "${database}" (still on "${next.currentDatabase ?? "none"}").`,
          { retryable: true },
        );
      }
      // Re-point the run's schema context at the new database so subsequent
      // tools see the switched catalog instead of the stale snapshot.
      ctx.currentDatabase = database;
      if (ctx.memoryScope) {
        ctx.memoryScope = { ...ctx.memoryScope, database };
      }
      ctx.latestTables = [...next.tables];
      ctx.availableSchemaTables = next.tables
        .map((table) => buildWorkspaceTableIdentifier(table, database))
        .filter(Boolean);
      ctx.inspectedAgentTables.clear();
      ctx.relationalSchemaSummaryByTable.clear();
      return `Switched to database "${database}" (${next.tables.length} table(s) loaded). The schema context now describes this database — call list_tables or describe_table to inspect it.`;
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      return agentToolError(`switch_database failed. ${formatExecutionError(errorValue)}`, {
        retryable: isRetryableAgentToolError(errorValue),
      });
    }
  },
};
