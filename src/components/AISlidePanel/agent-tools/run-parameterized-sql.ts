import type { QueryParameterType } from "../../../types";
import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "../ai-agent-action-requestor";
import { agentSqlToolBlockedMessage } from "../ai-agent-engine-gates";
import { appendAgentFacts } from "../ai-agent-context";
import { summarizeAgentQueryObservation } from "../ai-agent-grounding";
import {
  agentQueryTimeoutHint,
  agentSqlErrorHint,
  agentToolError,
  analyzeAgentSqlForAgent,
  coerceAgentQueryParameter,
  isRetryableAgentToolError,
} from "../agent-tool-executor-helpers";
import { stringifyAgentObservation, type AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "run_parameterized_sql",
  handler: async (ctx, args, frame) => {
    if (ctx.toolAvailability && !ctx.toolAvailability.sqlRead) {
      return agentSqlToolBlockedMessage("run_parameterized_sql", ctx.toolAvailability);
    }
    const sql = typeof args?.sql === "string" ? args.sql.trim() : "";
    if (!sql) {
      return agentToolError("run_parameterized_sql requires args.sql.", {
        hint: "Send args.sql with :name placeholders plus args.parameters bindings.",
      });
    }
    const rawParameters = Array.isArray(args?.parameters) ? args.parameters : [];
    const parameters: Array<{ name: string; value: unknown; dataType: QueryParameterType }> = [];
    for (const item of rawParameters) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (!name || !("value" in record)) {
        return agentToolError(
          'every parameters[] entry requires a non-empty "name" and a "value".',
          {
            hint: 'Each entry: {"name":"status","value":"active"} — referenced in SQL as :status.',
          },
        );
      }
      parameters.push(coerceAgentQueryParameter(name, record.value, record.dataType));
    }
    if (parameters.length === 0) {
      return agentToolError(
        'run_parameterized_sql requires bindings like [{"name":"status","value":"active"}]. Reference them in SQL as :name.',
      );
    }

    const guard = analyzeAgentSqlForAgent(sql, ctx.availableSchemaTables, ctx.inspectedAgentTables);
    if (!guard.ok) {
      return `Tool blocked: ${guard.error}`;
    }

    if (ctx.requestDataReadConsent) {
      const approved = await ctx.requestDataReadConsent();
      if (!approved) {
        return "Tool blocked: The user did not grant permission to read live database rows for this request.";
      }
    }

    try {
      const queryResult = await ctx.executeParameterizedReadonlyQuery(
        ctx.connectionId!,
        sql,
        parameters,
      );
      if (ctx.requestId !== ctx.requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }
      return appendAgentFacts(
        stringifyAgentObservation(frame, {
          parameterized: true,
          parameterCount: parameters.length,
          result: summarizeAgentQueryObservation(queryResult),
        }),
        {
          rowsReturned: queryResult.rows.length,
          insightEvidence: { executedSql: sql, rowCount: queryResult.rows.length },
        },
      );
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      return agentToolError(`parameterized query failed: ${formatExecutionError(errorValue)}`, {
        hint:
          agentSqlErrorHint(errorValue) ?? (agentQueryTimeoutHint(errorValue).trim() || undefined),
        retryable: isRetryableAgentToolError(errorValue),
      });
    }
  },
};
