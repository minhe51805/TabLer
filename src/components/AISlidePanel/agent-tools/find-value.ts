import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "../ai-agent-action-requestor";
import { agentSqlToolBlockedMessage } from "../ai-agent-engine-gates";
import { findMatchingTableName, summarizeAgentQueryObservation } from "../ai-agent-grounding";
import { AI_AGENT_SAMPLE_MAX_ROWS } from "../ai-agent-tools";
import {
  agentQueryTimeoutHint,
  agentSqlErrorHint,
  agentSqlQuoteIdentifier,
  agentToolError,
  coerceAgentQueryParameter,
  isRetryableAgentToolError,
} from "../agent-tool-executor-helpers";
import { stringifyAgentObservation, type AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "find_value",
  handler: async (ctx, args, frame) => {
    if (ctx.toolAvailability && !ctx.toolAvailability.sqlRead) {
      return agentSqlToolBlockedMessage("find_value", ctx.toolAvailability);
    }
    const requestedTable = typeof args?.table === "string" ? args.table.trim() : "";
    const requestedColumn = typeof args?.column === "string" ? args.column.trim() : "";
    if (!requestedTable || !requestedColumn) {
      return agentToolError("find_value requires args.table and args.column.", {
        hint: "Send args.table (verified name), args.column (verified column) and args.value.",
      });
    }
    if (!("value" in args)) {
      return agentToolError("find_value requires args.value.", {
        hint: "Send args.value — the exact value to match; numbers may be unquoted.",
      });
    }

    const matchedTable = findMatchingTableName(requestedTable, ctx.availableSchemaTables);
    if (!matchedTable) {
      return agentToolError(
        `Table "${requestedTable}" is not present in the current workspace schema.`,
        { hint: ctx.tableNotFoundHint(requestedTable) },
      );
    }

    // Verify the column against the real structure so a hallucinated column
    // name fails here with the actual list instead of at the driver.
    const columns = await ctx.getTableColumnsPreview(
      ctx.connectionId!,
      matchedTable,
      ctx.currentDatabase || undefined,
    );
    if (ctx.requestId !== ctx.requestIdRef.current) {
      throw new Error(AI_REQUEST_REPLACED_MESSAGE);
    }
    const matchedColumn = columns.find(
      (column) => column.name.toLowerCase() === requestedColumn.toLowerCase(),
    );
    if (!matchedColumn) {
      return agentToolError(
        `Column "${requestedColumn}" does not exist on ${matchedTable}. Available columns: ${columns.map((column) => column.name).join(", ")}.`,
        { hint: "Use one of the listed column names exactly." },
      );
    }

    if (ctx.requestDataReadConsent) {
      const approved = await ctx.requestDataReadConsent();
      if (!approved) {
        return "Tool blocked: The user did not grant permission to read live database rows for this request.";
      }
    }

    const requestedLimit =
      typeof args?.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(AI_AGENT_SAMPLE_MAX_ROWS, Math.max(1, Math.floor(args.limit)))
        : 10;
    const quotedTable = agentSqlQuoteIdentifier(ctx.dbType, matchedTable);
    const quotedColumn = agentSqlQuoteIdentifier(ctx.dbType, matchedColumn.name);
    const binding = coerceAgentQueryParameter("value", args.value);
    const sql =
      ctx.dbType === "mssql"
        ? `SELECT TOP (${requestedLimit}) * FROM ${quotedTable} WHERE ${quotedColumn} = :value`
        : `SELECT * FROM ${quotedTable} WHERE ${quotedColumn} = :value LIMIT ${requestedLimit}`;

    try {
      frame.sql = sql;
      const queryResult = await ctx.executeParameterizedReadonlyQuery(ctx.connectionId!, sql, [
        binding,
      ]);
      if (ctx.requestId !== ctx.requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }
      ctx.inspectedAgentTables.add(matchedTable);
      return stringifyAgentObservation(frame, {
        table: matchedTable,
        column: matchedColumn.name,
        value: binding.value,
        parameterized: true,
        result: summarizeAgentQueryObservation(queryResult),
      });
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      return agentToolError(`find_value failed: ${formatExecutionError(errorValue)}`, {
        hint:
          agentSqlErrorHint(errorValue) ?? (agentQueryTimeoutHint(errorValue).trim() || undefined),
        retryable: isRetryableAgentToolError(errorValue),
      });
    }
  },
};
