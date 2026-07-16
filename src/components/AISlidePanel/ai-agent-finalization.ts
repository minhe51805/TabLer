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
    return { title, type, query };
  }).filter((widget) => widget.title.length > 0 && widget.query.length > 0).slice(0, 12);
}

export async function finalizeAgentResult(options: FinalizeAgentResultOptions): Promise<AgentFinalization> {
  const { availableSchemaTables, buildControllerPrompt, initialAction, initialSteps, recoverFinishAction, requestAgentAction, sharedAgentInstruction } = options;
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

  const args = finalAction.args || {};
  if (!sql && typeof args.response === "string") {
    const fromResponse = extractSqlFromResponse(args.response);
    if (fromResponse && hasSqlStartKeyword(fromResponse) && !(availableSchemaTables.length > 0 && sqlResponseConflictsWithSchema(fromResponse, availableSchemaTables))) sql = fromResponse;
  }
  const shouldExposeSql = hasSqlStartKeyword(sql);
  const responseBody = typeof args.response === "string" && args.response.trim() ? args.response.trim() : finalAction.message?.trim() || (sql ? "The agent prepared grounded SQL for your review." : "The agent finished its inspection but did not produce a usable final answer.");
  // Agent steps are returned separately for the live trace UI. Never append them
  // to the user-facing response, otherwise internal tool logs leak into chat.
  const rawResponse = shouldExposeSql
    ? responseBody
    : stripSqlCodeBlocksFromResponse(responseBody) || responseBody;
  const widgets = buildWidgets(args as Record<string, unknown>);
  return { rawResponse, sql: shouldExposeSql ? sql : null, agentSteps: buildSteps(agentTraceSteps), agentWidgets: widgets.length ? widgets : undefined };
}
