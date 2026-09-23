/**
 * Hook-side implementation of the `manageMetricsBoard` executor dep — the
 * storage/layout/query half of the manage_metrics_widget tool. Kept out of
 * the tool module because it touches board localStorage, the UI store, and
 * the metrics query engine; the tool itself only validates args and formats
 * the observation.
 *
 * Board resolution mirrors useAIMetricsBoardActions: an explicit boardId wins,
 * then the metrics board open in the active tab, then the first metrics tab
 * for this connection+database, then the first stored board for the
 * connection.
 */
import {
  canPlaceWidget,
  clampColSpan,
  clampRowSpan,
  createWidgetDefinition,
  executeMetricsQuery,
  findFirstAvailablePosition,
  getWidgetLibraryItem,
  normalizeWidgetLayout,
  readStoredBoards,
  validateMetricsQuery,
  writeStoredBoards,
} from "../../MetricsBoard/utils/query-builder";
import { useUIStore } from "../../../stores/uiStore";
import type { MetricsBoardDefinition, MetricsWidgetDefinition } from "../../../types";
import type { AgentMetricsBoardRequest, AgentMetricsBoardResult } from "../ai-agent-tool-executor";

/** Title matching ignores case and diacritics (same rule as the AI board hook). */
function normalizeWidgetTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function resolveBoard(
  request: AgentMetricsBoardRequest,
  connectionId: string,
  database: string | null,
): MetricsBoardDefinition | null {
  const boards = readStoredBoards().filter((board) => board.connection_id === connectionId);
  if (boards.length === 0) return null;
  if (request.boardId) {
    return boards.find((board) => board.id === request.boardId) ?? null;
  }
  const { tabs, activeTabId } = useUIStore.getState();
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const metricsTab =
    tabs.find(
      (tab) =>
        tab.type === "metrics" &&
        tab.connectionId === connectionId &&
        (tab.database || "") === (database || ""),
    ) ?? null;
  const targetBoardId = activeTab?.metricsBoardId || metricsTab?.metricsBoardId;
  if (targetBoardId) {
    const target = boards.find((board) => board.id === targetBoardId);
    if (target) return target;
  }
  return boards.find((board) => (board.database || "") === (database || "")) ?? boards[0];
}

function findWidget(
  board: MetricsBoardDefinition,
  request: AgentMetricsBoardRequest,
): MetricsWidgetDefinition | null {
  if (request.widgetId) {
    return board.widgets.find((widget) => widget.id === request.widgetId) ?? null;
  }
  const title = request.widgetTitle?.trim();
  if (!title) return null;
  const normalized = normalizeWidgetTitle(title);
  return (
    board.widgets.find((widget) => normalizeWidgetTitle(widget.title) === normalized) ||
    board.widgets.find((widget) => normalizeWidgetTitle(widget.title).includes(normalized)) ||
    board.widgets.find((widget) => normalized.includes(normalizeWidgetTitle(widget.title))) ||
    null
  );
}

function persistBoards(nextBoards: MetricsBoardDefinition[], connectionId: string) {
  writeStoredBoards(nextBoards);
  window.dispatchEvent(
    new CustomEvent("metrics-boards-updated", {
      detail: { connectionId },
    }),
  );
}

/** Replace one board inside stored state and notify open board views. */
function persistBoard(nextBoard: MetricsBoardDefinition, connectionId: string) {
  persistBoards(
    readStoredBoards().map((entry) => (entry.id === nextBoard.id ? nextBoard : entry)),
    connectionId,
  );
}

/** update/delete/refresh all target an existing widget — resolve or fail once. */
function requireWidget(
  board: MetricsBoardDefinition,
  request: AgentMetricsBoardRequest,
): MetricsWidgetDefinition {
  const widget = findWidget(board, request);
  if (!widget) {
    const titles = board.widgets.map((entry) => entry.title).join(", ");
    throw new Error(
      `Widget not found on board "${board.name}". Available widgets: ${titles || "(none)"}. Call manage_metrics_widget with action "list" first.`,
    );
  }
  return widget;
}

function assertRunnableQuery(query: string, errorPrefix: string) {
  const validation = validateMetricsQuery(query);
  if (!validation.ok) {
    throw new Error(`${errorPrefix}: ${validation.error}`);
  }
  return validation;
}

export async function manageAgentMetricsBoard(
  request: AgentMetricsBoardRequest,
  options: { connectionId: string | null; database: string | null },
): Promise<AgentMetricsBoardResult> {
  const { connectionId, database } = options;
  if (!connectionId) {
    throw new Error(
      "No active connection — connect to a database before managing a metrics board.",
    );
  }
  const board = resolveBoard(request, connectionId, database);
  if (!board) {
    throw new Error(
      "No metrics board found for this connection. The user can open one from the metrics panel, or finish a run with metricsWidgets to create one.",
    );
  }

  switch (request.action) {
    case "list":
      return {
        boardId: board.id,
        boardName: board.name,
        widgetCount: board.widgets.length,
        widgets: board.widgets.map((widget) => ({
          id: widget.id,
          title: widget.title,
          type: widget.type,
          colSpan: widget.col_span,
          rowSpan: widget.row_span,
          query: widget.query,
        })),
      };

    case "add": {
      const title = request.title?.trim();
      if (!title) {
        throw new Error('add requires a widget "title".');
      }
      const query = request.query?.trim();
      if (!query) {
        throw new Error('add requires a read-only SELECT "query" feeding the widget.');
      }
      assertRunnableQuery(
        query,
        "Refusing to save a widget query that is not a single read-only statement",
      );
      const type = request.type ?? "table";
      if (!getWidgetLibraryItem(type)) {
        throw new Error(`Unknown widget type "${type}".`);
      }
      const newWidget = createWidgetDefinition(type, board.widgets, undefined, {
        title,
        query,
        colSpan: request.colSpan !== undefined ? clampColSpan(request.colSpan) : undefined,
        rowSpan: request.rowSpan !== undefined ? clampRowSpan(request.rowSpan) : undefined,
      });
      const nextBoard: MetricsBoardDefinition = {
        ...board,
        widgets: [...board.widgets, newWidget],
        updated_at: Date.now(),
      };
      persistBoard(nextBoard, connectionId);
      return {
        boardId: board.id,
        boardName: board.name,
        widgetCount: nextBoard.widgets.length,
        widgetId: newWidget.id,
        widgetTitle: newWidget.title,
        added: true,
      };
    }

    case "delete": {
      const widget = requireWidget(board, request);
      const nextBoard: MetricsBoardDefinition = {
        ...board,
        widgets: board.widgets.filter((entry) => entry.id !== widget.id),
        updated_at: Date.now(),
      };
      persistBoard(nextBoard, connectionId);
      return {
        boardId: board.id,
        boardName: board.name,
        widgetCount: nextBoard.widgets.length,
        widgetId: widget.id,
        widgetTitle: widget.title,
        deleted: true,
      };
    }

    case "refresh": {
      const widget = requireWidget(board, request);
      const validation = assertRunnableQuery(
        widget.query,
        `Widget "${widget.title}" has no runnable query`,
      );
      const result = await executeMetricsQuery(connectionId, validation.statement);
      // Re-dispatch so an open board re-reads storage; the card's own
      // refresh_seconds interval keeps re-querying afterwards.
      window.dispatchEvent(
        new CustomEvent("metrics-boards-updated", {
          detail: { connectionId },
        }),
      );
      return {
        boardId: board.id,
        boardName: board.name,
        widgetCount: board.widgets.length,
        widgetId: widget.id,
        widgetTitle: widget.title,
        refreshed: true,
        rowCount: result.rows?.length ?? 0,
      };
    }

    case "update": {
      const widget = requireWidget(board, request);
      const nextType = request.type ?? widget.type;
      const libraryItem = getWidgetLibraryItem(nextType);
      if (!libraryItem) {
        throw new Error(`Unknown widget type "${nextType}".`);
      }
      if (request.query !== undefined) {
        assertRunnableQuery(
          request.query,
          "Refusing to save a widget query that is not a single read-only statement",
        );
      }
      const grown: MetricsWidgetDefinition = {
        ...widget,
        type: nextType,
        title: request.title?.trim() || widget.title,
        query: request.query?.trim() || widget.query,
        col_span:
          request.colSpan !== undefined
            ? clampColSpan(request.colSpan)
            : nextType === widget.type
              ? widget.col_span
              : Math.max(widget.col_span, libraryItem.colSpan),
        row_span:
          request.rowSpan !== undefined
            ? clampRowSpan(request.rowSpan)
            : nextType === widget.type
              ? widget.row_span
              : Math.max(widget.row_span, libraryItem.rowSpan),
      };
      // Growing the span can push the widget off-grid or onto a neighbour —
      // normalize and re-place when it no longer fits (same rule as the AI hook).
      const normalized = normalizeWidgetLayout(grown);
      const others = board.widgets.filter((entry) => entry.id !== widget.id);
      const nextWidget = canPlaceWidget(others, normalized, widget.id)
        ? normalized
        : { ...normalized, ...findFirstAvailablePosition(others, normalized) };
      const changed = JSON.stringify(nextWidget) !== JSON.stringify(widget);
      if (changed) {
        persistBoard(
          {
            ...board,
            widgets: board.widgets.map((entry) => (entry.id === widget.id ? nextWidget : entry)),
            updated_at: Date.now(),
          },
          connectionId,
        );
      }
      return {
        boardId: board.id,
        boardName: board.name,
        widgetCount: board.widgets.length,
        widgetId: nextWidget.id,
        widgetTitle: nextWidget.title,
        changed,
      };
    }

    default: {
      const exhaustive: never = request.action;
      throw new Error(`Unknown manage_metrics_widget action "${String(exhaustive)}".`);
    }
  }
}
