import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";

import { useAppLayoutStore } from "../stores/appLayoutStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useGlobalErrorStore } from "../stores/globalErrorStore";
import { useQueryStore } from "../stores/queryStore";
import { useUIStore } from "../stores/uiStore";
import type { MetricsBoardDefinition, MetricsWidgetDefinition, TableInfo } from "../types";
import type {
  AIMetricsSchemaTableHint,
  OpenAIMetricsBoardCompletionDetail,
  OpenAIMetricsBoardDetail,
} from "../utils/metrics-board-templates";
import { emitAppToast } from "../utils/app-toast";

const BUSINESS_TABLE_PRIORITY = [
  "users",
  "sessions",
  "refresh_tokens",
  "oauth_client",
  "oauth_clients",
  "oauth_authorizations",
  "oauth_consents",
  "identities",
  "audit_log_entries",
  "audit_logs",
  "user_logs",
  "smart_alerts",
  "messages",
  "products",
  "categories",
  "brands",
  "coupons",
  "orders",
  "order_items",
  "reviews",
  "workspaces",
  "buckets",
  "objects",
  "job_post",
  "job_posts",
  "job_application",
  "job_applications",
  "organization",
  "organizations",
  "organization_type",
  "organization_types",
  "industry",
  "industries",
  "province",
  "provinces",
  "country",
  "countries",
  "interview_schedule",
  "interview_schedules",
  "interview_feedback",
  "interview_feedbacks",
  "interview_participants",
];

export function normalizeMetricsTableName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function prioritizeMetricsTables(tables: TableInfo[]): TableInfo[] {
  return [...tables]
    .sort((left, right) => {
      const leftPriority = BUSINESS_TABLE_PRIORITY.indexOf(normalizeMetricsTableName(left.name));
      const rightPriority = BUSINESS_TABLE_PRIORITY.indexOf(normalizeMetricsTableName(right.name));
      if (leftPriority !== rightPriority) {
        return (
          (leftPriority === -1 ? Number.MAX_SAFE_INTEGER : leftPriority) -
          (rightPriority === -1 ? Number.MAX_SAFE_INTEGER : rightPriority)
        );
      }
      const rowDifference = (right.row_count ?? -1) - (left.row_count ?? -1);
      return rowDifference || left.name.localeCompare(right.name);
    })
    .filter(
      (table, index, collection) =>
        collection.findIndex(
          (candidate) =>
            normalizeMetricsTableName(candidate.name) === normalizeMetricsTableName(table.name),
        ) === index,
    )
    .slice(0, 18);
}

function yieldToBrowserFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function dispatchCompletion(
  requestId: string | undefined,
  payload: OpenAIMetricsBoardCompletionDetail,
) {
  if (!requestId) return;
  window.dispatchEvent(
    new CustomEvent("open-ai-metrics-board-complete", {
      detail: { requestId, ...payload },
    }),
  );
}

async function collectMetricsSchemaHints(
  connectionId: string,
  database?: string,
): Promise<AIMetricsSchemaTableHint[]> {
  const connectionState = useConnectionStore.getState();
  if (
    connectionId !== connectionState.activeConnectionId ||
    (database || "") !== (connectionState.currentDatabase || "")
  ) {
    return [];
  }

  let tables = connectionState.tables ?? [];
  if (!tables.length && database) {
    await connectionState.fetchTables(connectionId, database);
    tables = useConnectionStore.getState().tables ?? [];
  }
  if (!tables.length) return [];

  const hints: AIMetricsSchemaTableHint[] = [];
  const prioritizedTables = prioritizeMetricsTables(tables);
  for (let index = 0; index < prioritizedTables.length; index += 4) {
    const batch = prioritizedTables.slice(index, index + 4);
    const batchHints = await Promise.all(
      batch.map(async (table) => {
        try {
          const structure = await useQueryStore
            .getState()
            .getTableStructure(connectionId, table.name, database);
          return {
            name: table.name,
            schema: table.schema,
            rowCount: table.row_count ?? null,
            columns: structure.columns.map((column) => column.name),
          } satisfies AIMetricsSchemaTableHint;
        } catch {
          return {
            name: table.name,
            schema: table.schema,
            rowCount: table.row_count ?? null,
            columns: [],
          } satisfies AIMetricsSchemaTableHint;
        }
      }),
    );
    hints.push(...batchHints);
    await yieldToBrowserFrame();
  }
  return hints;
}

function normalizeWidgetTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/**
 * Merge the AI-computed board delta onto freshly-read stored boards.
 *
 * `staleTarget` is the board as it looked when the action started; `computed`
 * is the board the action produced from it. Widgets the user changed or added
 * since the snapshot are preserved: a widget is only overwritten when the
 * computed version differs from the stale one (i.e. the AI touched it), and
 * widgets present in the fresh board but absent from the stale snapshot are
 * appended. A board the user deleted in the meantime is not resurrected.
 */
function mergeBoardDelta(
  freshBoards: MetricsBoardDefinition[],
  staleTarget: MetricsBoardDefinition | null,
  computed: MetricsBoardDefinition,
  created: boolean,
): MetricsBoardDefinition[] {
  if (created || !staleTarget) {
    return freshBoards.some((board) => board.id === computed.id)
      ? freshBoards.map((board) => (board.id === computed.id ? computed : board))
      : [...freshBoards, computed];
  }

  const freshTarget = freshBoards.find((board) => board.id === staleTarget.id);
  if (!freshTarget) return freshBoards;

  const staleWidgets = new Map(staleTarget.widgets.map((widget) => [widget.id, widget]));
  const mergedWidgets: MetricsWidgetDefinition[] = computed.widgets.map((computedWidget) => {
    const staleWidget = staleWidgets.get(computedWidget.id);
    const freshWidget = freshTarget.widgets.find((widget) => widget.id === computedWidget.id);
    if (!staleWidget || !freshWidget) return computedWidget;
    // Keep the user's concurrent edit unless the AI also changed the widget.
    return JSON.stringify(computedWidget) !== JSON.stringify(staleWidget)
      ? computedWidget
      : freshWidget;
  });
  const seen = new Set(mergedWidgets.map((widget) => widget.id));
  for (const freshWidget of freshTarget.widgets) {
    if (!seen.has(freshWidget.id) && !staleWidgets.has(freshWidget.id)) {
      mergedWidgets.push(freshWidget);
    }
  }

  const mergedBoard: MetricsBoardDefinition = {
    ...freshTarget,
    name: computed.name !== staleTarget.name ? computed.name : freshTarget.name,
    widgets: mergedWidgets,
    updated_at: Date.now(),
  };
  return freshBoards.map((board) => (board.id === mergedBoard.id ? mergedBoard : board));
}

export function useAIMetricsBoardActions(language: string) {
  const { activeConnectionId, connections, currentDatabase } = useConnectionStore(
    useShallow((state) => ({
      activeConnectionId: state.activeConnectionId,
      connections: state.connections,
      currentDatabase: state.currentDatabase,
    })),
  );
  const { tabs, activeTabId, addTab, setActiveTab, updateTab } = useUIStore(
    useShallow((state) => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      addTab: state.addTab,
      setActiveTab: state.setActiveTab,
      updateTab: state.updateTab,
    })),
  );
  const setLeftPanel = useAppLayoutStore((state) => state.setLeftPanel);
  const setError = useGlobalErrorStore((state) => state.setError);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  return useCallback(
    async (detail: OpenAIMetricsBoardDetail) => {
      const complete = (payload: OpenAIMetricsBoardCompletionDetail) =>
        dispatchCompletion(detail.requestId, payload);
      const targetConnectionId = detail.connectionId || activeConnectionId;
      const targetDatabase = detail.database || currentDatabase || undefined;
      if (!targetConnectionId) {
        complete({ success: false, error: "Missing target connection" });
        return;
      }
      const targetConnection = connections.find((item) => item.id === targetConnectionId);
      if (!targetConnection) {
        complete({ success: false, error: "Target connection not found" });
        return;
      }

      try {
        const [storage, templates] = await Promise.all([
          import("../components/MetricsBoard/utils/query-builder"),
          import("../utils/metrics-board-templates"),
        ]);
        const needsSchemaHints =
          detail.mode !== "edit" &&
          (detail.template ?? "database-overview") === "database-overview";
        const schemaHints = needsSchemaHints
          ? await collectMetricsSchemaHints(targetConnectionId, targetDatabase)
          : [];
        const allBoards = storage.readStoredBoards();
        const connectionBoards = allBoards.filter(
          (board) => board.connection_id === targetConnectionId,
        );
        const existingMetricsTab =
          tabs.find(
            (tab) =>
              tab.type === "metrics" &&
              tab.connectionId === targetConnectionId &&
              (tab.database || "") === (targetDatabase || ""),
          ) ?? null;
        const targetBoardId =
          detail.boardId ||
          (detail.mode === "augment" || detail.mode === "rebuild" || detail.mode === "edit"
            ? activeTab?.metricsBoardId || existingMetricsTab?.metricsBoardId
            : undefined);
        const targetBoard =
          (targetBoardId && connectionBoards.find((board) => board.id === targetBoardId)) || null;

        let nextBoard: typeof targetBoard = null;
        let didChange = false;
        let created = false;
        let addedCount = 0;
        let addedTitles: string[] = [];
        let addedWidgetIds: string[] = [];

        if (detail.mode === "edit" && targetBoard && detail.editTargetTitle) {
          const normalizedTarget = normalizeWidgetTitle(detail.editTargetTitle);
          const targetWidget =
            targetBoard.widgets.find(
              (widget) => normalizeWidgetTitle(widget.title) === normalizedTarget,
            ) ||
            targetBoard.widgets.find((widget) =>
              normalizeWidgetTitle(widget.title).includes(normalizedTarget),
            ) ||
            targetBoard.widgets.find((widget) =>
              normalizedTarget.includes(normalizeWidgetTitle(widget.title)),
            ) ||
            null;
          if (targetWidget) {
            const nextType = detail.editTargetType || targetWidget.type;
            const libraryItem = storage.getWidgetLibraryItem(nextType);
            const grownWidget = {
              ...targetWidget,
              type: nextType,
              title: detail.editTitle?.trim() || targetWidget.title,
              query: detail.editQuery?.trim() || targetWidget.query,
              col_span:
                nextType === targetWidget.type
                  ? targetWidget.col_span
                  : Math.max(targetWidget.col_span, libraryItem.colSpan),
              row_span:
                nextType === targetWidget.type
                  ? targetWidget.row_span
                  : Math.max(targetWidget.row_span, libraryItem.rowSpan),
            };
            // Growing the span can push the widget off-grid or onto a
            // neighbour — normalize and re-place when it no longer fits.
            const normalized = storage.normalizeWidgetLayout(grownWidget);
            const others = targetBoard.widgets.filter((widget) => widget.id !== targetWidget.id);
            const nextWidget = storage.canPlaceWidget(others, normalized, targetWidget.id)
              ? normalized
              : {
                  ...normalized,
                  ...storage.findFirstAvailablePosition(others, normalized),
                };
            const changed =
              nextWidget.type !== targetWidget.type ||
              nextWidget.title !== targetWidget.title ||
              nextWidget.query !== targetWidget.query ||
              nextWidget.col_span !== targetWidget.col_span ||
              nextWidget.row_span !== targetWidget.row_span ||
              nextWidget.grid_x !== targetWidget.grid_x ||
              nextWidget.grid_y !== targetWidget.grid_y;
            nextBoard = changed
              ? {
                  ...targetBoard,
                  widgets: targetBoard.widgets.map((widget) =>
                    widget.id === targetWidget.id ? nextWidget : widget,
                  ),
                  updated_at: Date.now(),
                }
              : targetBoard;
            didChange = changed;
            addedCount = changed ? 1 : 0;
            addedTitles = [nextWidget.title];
            addedWidgetIds = [nextWidget.id];
          }
        }

        if (detail.mode === "edit") {
          if (!targetBoard) {
            complete({ success: false, error: "Target dashboard not found" });
            return;
          }
          nextBoard ??= targetBoard;
        }

        if (!nextBoard && (detail.mode === "augment" || detail.mode === "rebuild") && targetBoard) {
          const result =
            detail.mode === "rebuild"
              ? templates.rebuildAIMetricsBoardDefinition({
                  board: targetBoard,
                  detail: { ...detail, database: targetDatabase },
                  dbType: targetConnection.db_type,
                  schemaHints,
                })
              : templates.augmentAIMetricsBoardDefinition({
                  board: targetBoard,
                  detail: { ...detail, database: targetDatabase },
                  dbType: targetConnection.db_type,
                  schemaHints,
                });
          if (result) {
            nextBoard = result.board;
            addedCount = result.addedCount;
            addedTitles = result.addedTitles;
            addedWidgetIds = result.addedWidgetIds;
            didChange =
              detail.mode === "rebuild" ||
              addedCount > 0 ||
              result.board.name.trim() !== targetBoard.name.trim();
            if (!didChange) nextBoard = targetBoard;
          }
        }

        // Agent-proposed widgets on an existing board: append them in place
        // instead of creating a second board. Runs before the aiWidgets
        // create-branch below, which only fires when no target board exists.
        if (!nextBoard && detail.mode === "augment" && targetBoard && detail.aiWidgets?.length) {
          const appended = templates.appendAIMetricsWidgetsToBoard({
            board: targetBoard,
            widgets: detail.aiWidgets,
          });
          if (appended) {
            nextBoard = appended.board;
            addedCount = appended.addedCount;
            addedTitles = appended.addedTitles;
            addedWidgetIds = appended.addedWidgetIds;
            didChange = appended.addedCount > 0;
            if (!didChange) nextBoard = targetBoard;
          }
        }
        if (!nextBoard && detail.aiWidgets?.length) {
          const board = templates.createAIMetricsBoardFromWidgets({
            widgets: detail.aiWidgets,
            title: detail.title,
            database: targetDatabase,
            connectionId: targetConnectionId,
            existingBoards: connectionBoards,
          });
          if (board) {
            nextBoard = board;
            didChange = true;
            created = true;
            addedCount = board.widgets.length;
            addedTitles = board.widgets.map((widget) => widget.title);
            addedWidgetIds = board.widgets.map((widget) => widget.id);
          }
        }

        if (!nextBoard) {
          nextBoard = templates.createAIMetricsBoardDefinition({
            detail: { ...detail, database: targetDatabase },
            dbType: targetConnection.db_type,
            connectionId: targetConnectionId,
            existingBoards: connectionBoards,
            schemaHints,
          });
          if (nextBoard) {
            didChange = true;
            created = true;
          }
        }

        if (!nextBoard) {
          emitAppToast({
            tone: "info",
            title:
              language === "vi"
                ? "Dashboard chua ho tro cho engine nay"
                : "Dashboard template is not available here",
            description:
              language === "vi"
                ? "TableR chua co san dashboard overview da widget cho engine database hien tai."
                : "TableR does not have a built-in multi-chart overview dashboard for the current database engine yet.",
          });
          complete({
            success: false,
            error: "Dashboard template is not available for the current database engine",
          });
          return;
        }

        if (didChange) {
          // Re-read right before writing: the schema-hint collection above can
          // take seconds, and the user may have edited boards meanwhile.
          // Apply only the computed delta onto the fresh state so concurrent
          // user edits survive.
          const freshBoards = storage.readStoredBoards();
          const mergedBoards = mergeBoardDelta(freshBoards, targetBoard, nextBoard, created);
          storage.writeStoredBoards(mergedBoards);
          window.dispatchEvent(
            new CustomEvent("metrics-boards-updated", {
              detail: { connectionId: targetConnectionId },
            }),
          );
        }
        setLeftPanel("metrics");
        if (existingMetricsTab) {
          updateTab(existingMetricsTab.id, {
            metricsBoardId: nextBoard.id,
            title: nextBoard.name,
            database: nextBoard.database,
          });
          setActiveTab(existingMetricsTab.id);
        } else {
          addTab({
            id: `metrics-${crypto.randomUUID()}`,
            type: "metrics",
            title: nextBoard.name,
            connectionId: targetConnectionId,
            database: nextBoard.database,
            metricsBoardId: nextBoard.id,
          });
        }
        complete({
          success: true,
          boardId: nextBoard.id,
          didChange,
          addedCount,
          addedTitles,
          addedWidgetIds,
          created,
        });
        if (didChange && addedWidgetIds.length) {
          window.setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent("focus-metrics-widget", {
                detail: { boardId: nextBoard!.id, widgetId: addedWidgetIds[0] },
              }),
            );
          }, 60);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setError(
          language === "vi"
            ? `Khong the mo dashboard AI: ${message}`
            : `Could not open the AI dashboard: ${message}`,
        );
        complete({ success: false, error: message });
      }
    },
    [
      activeConnectionId,
      activeTab?.metricsBoardId,
      addTab,
      connections,
      currentDatabase,
      language,
      setActiveTab,
      setError,
      setLeftPanel,
      tabs,
      updateTab,
    ],
  );
}
