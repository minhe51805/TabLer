import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "../ai-agent-action-requestor";
import { agentToolError, isRetryableAgentToolError } from "../agent-tool-executor-helpers";
import type { MetricsWidgetType } from "../../../types";
import type { AgentMetricsBoardRequest } from "../ai-agent-tool-executor";
import type { AgentToolModule } from "./shared";

const WIDGET_TYPES: readonly MetricsWidgetType[] = [
  "table",
  "scoreboard",
  "bar",
  "horizontal-bar",
  "stacked-bar",
  "line",
  "area",
  "pie",
  "donut",
  "radial",
  "funnel",
  "delta",
  "markdown",
];

export const tool: AgentToolModule = {
  name: "manage_metrics_widget",
  handler: async (ctx, args) => {
    if (typeof ctx.manageMetricsBoard !== "function") {
      return agentToolError("manage_metrics_widget is unavailable in this context.");
    }
    const action = typeof args?.action === "string" ? args.action.trim() : "";
    if (!["list", "update", "delete", "refresh"].includes(action)) {
      return agentToolError(
        'manage_metrics_widget requires args.action: "list", "update", "delete", or "refresh".',
      );
    }
    const widgetId = typeof args?.widgetId === "string" ? args.widgetId.trim() : "";
    const widgetTitle = typeof args?.widgetTitle === "string" ? args.widgetTitle.trim() : "";
    if (action !== "list" && !widgetId && !widgetTitle) {
      return agentToolError(
        `manage_metrics_widget "${action}" needs a target widget: pass args.widgetId (from a list call) or args.widgetTitle.`,
      );
    }
    const request: AgentMetricsBoardRequest = {
      action: action as AgentMetricsBoardRequest["action"],
      boardId: typeof args?.boardId === "string" ? args.boardId.trim() || undefined : undefined,
      widgetId: widgetId || undefined,
      widgetTitle: widgetTitle || undefined,
      title: typeof args?.title === "string" ? args.title : undefined,
      query: typeof args?.query === "string" ? args.query : undefined,
      type: WIDGET_TYPES.includes(args?.type as MetricsWidgetType)
        ? (args.type as MetricsWidgetType)
        : undefined,
      colSpan: typeof args?.colSpan === "number" ? args.colSpan : undefined,
      rowSpan: typeof args?.rowSpan === "number" ? args.rowSpan : undefined,
    };
    if (
      action === "update" &&
      request.title === undefined &&
      request.query === undefined &&
      request.type === undefined &&
      request.colSpan === undefined &&
      request.rowSpan === undefined
    ) {
      return agentToolError(
        'manage_metrics_widget "update" needs at least one field to change: title, query, type, colSpan, or rowSpan.',
      );
    }
    // A superseded run must not touch board storage or the database.
    if (ctx.requestId !== ctx.requestIdRef.current) {
      throw new Error(AI_REQUEST_REPLACED_MESSAGE);
    }
    ctx.publishAgentProgress({
      action: "manage_metrics_widget",
      message: `${action} on the open metrics board.`,
    });
    try {
      const result = await ctx.manageMetricsBoard(request);
      if (ctx.requestId !== ctx.requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }
      if (action === "list") {
        const widgets = result.widgets ?? [];
        if (widgets.length === 0) {
          return `Board "${result.boardName}" (${result.boardId}) has no widgets.`;
        }
        const lines = widgets.map(
          (widget, index) =>
            `${index + 1}. "${widget.title}" [${widget.type}] id=${widget.id} span=${widget.colSpan}x${widget.rowSpan} query: ${widget.query || "(none)"}`,
        );
        return [
          `Board "${result.boardName}" (${result.boardId}) — ${widgets.length} widget(s):`,
          ...lines,
        ].join("\n");
      }
      if (action === "delete") {
        return `Deleted widget "${result.widgetTitle}" (${result.widgetId}) from board "${result.boardName}". ${result.widgetCount} widget(s) remain.`;
      }
      if (action === "refresh") {
        return `Refreshed widget "${result.widgetTitle}" on board "${result.boardName}": the query ran successfully and returned ${result.rowCount} row(s). The card keeps re-querying on its own refresh interval.`;
      }
      return result.changed
        ? `Updated widget "${result.widgetTitle}" (${result.widgetId}) on board "${result.boardName}".`
        : `Widget "${result.widgetTitle}" already matches the requested values — nothing changed.`;
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      return agentToolError(`manage_metrics_widget failed. ${formatExecutionError(errorValue)}`, {
        retryable: isRetryableAgentToolError(errorValue),
      });
    }
  },
};
