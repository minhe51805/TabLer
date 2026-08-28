import type { AIMetricsWidgetSpec } from "../../utils/metrics-board-templates";
import type { AIAgentFinishAction, AIAgentToolAction } from "./ai-agent-tools";
import { joinAgentInstructions, type AgentTraceStep } from "./ai-agent-context";
import { sqlResponseConflictsWithSchema } from "./ai-agent-grounding";
import { extractSqlFromResponse, hasSqlStartKeyword, stripSqlCodeBlocksFromResponse } from "./ai-sql-response";
import type { AIWorkspaceAgentStep } from "./ai-workspace-types";

export interface AgentFinalization {
  agentSteps?: AIWorkspaceAgentStep[];
  agentWidgets?: AIMetricsWidgetSpec[];
  rawResponse: string;
  sql: string | null;
}

interface FinalizeAgentResultOptions {
  availableSchemaTables: string[];
  buildControllerPrompt: (forceFinish: boolean, extraInstruction?: string, steps?: AgentTraceStep[]) => string;
  initialAction: AIAgentFinishAction;
  initialSteps: AgentTraceStep[];
  recoverFinishAction: (reason: string) => Promise<AIAgentFinishAction>;
  requestAgentAction: (prompt: string, includeHistory: boolean) => Promise<AIAgentToolAction>;
  sharedAgentInstruction: string;
  /**
   * Optional sandbox pre-flight for the proposed final SQL. Returns null when
   * the SQL runs (or cannot be validated); returns the execution error text
   * otherwise, which triggers one bounded repair round before the SQL is
   * exposed for human approval.
   */
  validateSql?: (sql: string) => Promise<string | null>;
}

function buildSteps(steps: AgentTraceStep[]): AIWorkspaceAgentStep[] {
  return steps.map((step) => ({
    step: step.step, action: step.action, message: step.message, observation: step.observation,
    status: step.observation.startsWith("Tool error") || step.observation.startsWith("Tool blocked") ? "error" : "done",
  }));
}

function buildWidgets(args: Record<string, unknown>): AIMetricsWidgetSpec[] {
  const rawWidgets = Array.isArray(args.metricsWidgets) ? args.metricsWidgets : [];
  return rawWidgets.map((widget) => {
    const record = widget && typeof widget === "object" ? widget as Record<string, unknown> : {};
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const query = typeof record.query === "string" ? record.query.trim() : typeof record.sql === "string" ? record.sql.trim() : "";
    const typeValue = typeof record.type === "string" ? record.type.trim().toLowerCase() : "table";
    const type = (["table", "scoreboard", "bar", "horizontal-bar", "line", "area", "pie", "donut", "radial"].includes(typeValue) ? typeValue : "table") as AIMetricsWidgetSpec["type"];
    const dimension = typeof record.dimension === "string" ? record.dimension.trim() || undefined : undefined;
    const measures = Array.isArray(record.measures)
      ? record.measures.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean).slice(0, 12)
      : [];
    const transforms = Array.isArray(record.transforms)
      ? record.transforms.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean).slice(0, 12)
      : [];
    const limit = typeof record.limit === "number" && Number.isFinite(record.limit)
      ? Math.min(10_000, Math.max(1, Math.floor(record.limit)))
      : 100;
    return { title, type, query, dimension, measures, transforms, limit };
  }).filter((widget) => widget.title.length > 0 && widget.query.length > 0).slice(0, 12);
}

export async function finalizeAgentResult(options: FinalizeAgentResultOptions): Promise<AgentFinalization> {
  const { availableSchemaTables, buildControllerPrompt, initialAction, initialSteps, recoverFinishAction, requestAgentAction, sharedAgentInstruction, validateSql } = options;
  const agentTraceSteps = [...initialSteps];
  let finalAction = initialAction;
  let sql = typeof finalAction.args?.sql === "string" ? finalAction.args.sql.trim() : "";
  if (sql) sql = extractSqlFromResponse(sql) || sql;

  if (sql && availableSchemaTables.length > 0 && sqlResponseConflictsWithSchema(sql, availableSchemaTables)) {
    agentTraceSteps.push({ step: agentTraceSteps.length + 1, action: "finish", message: finalAction.message || "Final answer rejected.", observation: "Tool error: The proposed final SQL referenced tables outside the current workspace schema." });
    const repaired = await requestAgentAction(buildControllerPrompt(true, joinAgentInstructions(sharedAgentInstruction, "Your previous finish action referenced tables outside the current schema. Return a corrected finish action now.")), false);
    finalAction = repaired.action === "finish" ? repaired : await recoverFinishAction("The agent failed to repair its final answer after SQL validation.");
    sql = typeof finalAction.args?.sql === "string" ? finalAction.args.sql.trim() : "";
    if (sql) sql = extractSqlFromResponse(sql) || sql;
  }

  // Sandbox pre-flight: a final SQL the agent never executed may still fail
  // (hallucinated columns, engine dialect slips). Run it once, and on error
  // give the model exactly one repair round before anything reaches the user.
  let sqlValidationError: string | null = null;
  if (sql && validateSql) {
    sqlValidationError = await validateSql(sql);
    if (sqlValidationError) {
      agentTraceSteps.push({
        step: agentTraceSteps.length + 1,
        action: "finish",
        message: finalAction.message || "Final SQL failed sandbox validation.",
        observation: `Tool error: ${sqlValidationError}`,
      });
      const repaired = await requestAgentAction(
        buildControllerPrompt(
          true,
          joinAgentInstructions(
            sharedAgentInstruction,
            `Your proposed final SQL failed sandbox validation with: ${sqlValidationError}. Return a corrected finish action now with SQL that actually runs. Use only columns verified by earlier describe/sample observations; row counts come from list_tables rowCount.`,
          ),
        ),
        false,
      );
      if (repaired.action === "finish") {
        finalAction = repaired;
        let repairedSql = typeof finalAction.args?.sql === "string" ? finalAction.args.sql.trim() : "";
        if (repairedSql) repairedSql = extractSqlFromResponse(repairedSql) || repairedSql;
        if (repairedSql) {
          const secondError = await validateSql(repairedSql);
          if (!secondError) {
            sql = repairedSql;
            sqlValidationError = null;
          } else {
            sql = repairedSql;
            sqlValidationError = secondError;
          }
        }
      }
    }
  }

  const args = finalAction.args || {};
  if (!sql && typeof args.response === "string") {
    const fromResponse = extractSqlFromResponse(args.response);
    if (fromResponse && hasSqlStartKeyword(fromResponse) && !(availableSchemaTables.length > 0 && sqlResponseConflictsWithSchema(fromResponse, availableSchemaTables))) sql = fromResponse;
  }
  const shouldExposeSql = hasSqlStartKeyword(sql);
  const baseResponseBody = typeof args.response === "string" && args.response.trim()
    ? args.response.trim()
    : finalAction.message?.trim() || (sql ? "The agent prepared grounded SQL for your review." : "The agent finished its inspection but did not produce a usable final answer.");
  const responseBody = sqlValidationError
    ? `${baseResponseBody}\n\n> ⚠️ **Lưu ý:** SQL đề xuất **chưa pass sandbox validation** — \`${sqlValidationError}\` · The proposed SQL did not pass sandbox validation; review or fix it before running.`
    : baseResponseBody;
  // Agent steps are returned separately for the live trace UI. Never append them
  // to the user-facing response, otherwise internal tool logs leak into chat.
  const rawResponse = shouldExposeSql
    ? responseBody
    : stripSqlCodeBlocksFromResponse(responseBody) || responseBody;
  const widgets = buildWidgets(args as Record<string, unknown>);
  return { rawResponse, sql: shouldExposeSql ? sql : null, agentSteps: buildSteps(agentTraceSteps), agentWidgets: widgets.length ? widgets : undefined };
}
