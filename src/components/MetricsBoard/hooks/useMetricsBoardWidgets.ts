import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { MetricsBoardDefinition, MetricsWidgetDefinition, MetricsWidgetType } from "../../../types";
import {
  canPlaceWidget,
  createBoardDefinition,
  createWidgetDefinition,
  findFirstAvailablePosition,
  normalizeWidgetLayout,
  type GridPosition,
} from "../utils/query-builder";

export type CanvasContextMenuState = {
  left: number;
  top: number;
  grid_x: number;
  grid_y: number;
  submenuOpen: boolean;
};

interface UseMetricsBoardWidgetsParams {
  connectionId: string;
  database?: string;
  boards: MetricsBoardDefinition[];
  activeBoard: MetricsBoardDefinition | null | undefined;
  editingWidget: MetricsWidgetDefinition | null | undefined;

  persistBoards: (nextBoards: MetricsBoardDefinition[]) => void;
  setActiveBoardId: Dispatch<SetStateAction<string | null>>;
  setActiveWidgetId: Dispatch<SetStateAction<string | null>>;
  setEditingWidgetId: Dispatch<SetStateAction<string | null>>;
  setCanvasContextMenu: Dispatch<SetStateAction<CanvasContextMenuState | null>>;
}

/**
 * Widget CRUD on the active board: layout updates with collision-aware
 * placement, creation, selection updates and deletion. Handlers are moved
 * verbatim from the board component body.
 */
export function useMetricsBoardWidgets({
  connectionId,
  database,
  boards,
  activeBoard,
  editingWidget,
  persistBoards,
  setActiveBoardId,
  setActiveWidgetId,
  setEditingWidgetId,
  setCanvasContextMenu,
}: UseMetricsBoardWidgetsParams) {
  const updateActiveBoard = useCallback(
    (updater: (board: MetricsBoardDefinition) => MetricsBoardDefinition) => {
      if (!activeBoard) return;
      const nextBoards = boards.map((board) =>
        board.id === activeBoard.id
          ? { ...updater(board), updated_at: Date.now() }
          : board,
      );
      persistBoards(nextBoards);
    },
    [activeBoard, boards, persistBoards],
  );

  const updateWidgetLayout = useCallback(
    (widgetId: string, updates: Partial<MetricsWidgetDefinition>) => {
      if (!activeBoard) return;

      updateActiveBoard((board) => {
        const currentWidget = board.widgets.find(
          (widget) => widget.id === widgetId,
        );
        if (!currentWidget) return board;

        const others = board.widgets.filter((widget) => widget.id !== widgetId);
        const candidate = normalizeWidgetLayout({
          ...currentWidget,
          ...updates,
        });
        const positioned = canPlaceWidget(others, candidate, widgetId)
          ? candidate
          : { ...candidate, ...findFirstAvailablePosition(others, candidate) };

        return {
          ...board,
          widgets: board.widgets.map((widget) =>
            widget.id === widgetId ? positioned : widget,
          ),
        };
      });
    },
    [activeBoard, updateActiveBoard],
  );

  const createBoard = useCallback(() => {
    const nextBoard = createBoardDefinition(connectionId, database, boards);
    const nextBoards = [nextBoard, ...boards];
    persistBoards(nextBoards);
    setActiveBoardId(nextBoard.id);
    setActiveWidgetId(null);
    setEditingWidgetId(null);
  }, [boards, connectionId, database, persistBoards]);

  const addWidget = useCallback(
    (type: MetricsWidgetType, preferredPosition?: Partial<GridPosition>) => {
      if (!activeBoard) return;
      const nextWidget = createWidgetDefinition(
        type,
        activeBoard.widgets,
        preferredPosition,
      );
      updateActiveBoard((board) => ({
        ...board,
        widgets: [...board.widgets, nextWidget],
      }));
      setActiveWidgetId(nextWidget.id);
      setEditingWidgetId(nextWidget.id);
      setCanvasContextMenu(null);
    },
    [activeBoard, updateActiveBoard],
  );

  const updateSelectedWidget = useCallback(
    (updates: Partial<MetricsWidgetDefinition>) => {
      if (!editingWidget) return;
      if (
        "col_span" in updates ||
        "row_span" in updates ||
        "grid_x" in updates ||
        "grid_y" in updates
      ) {
        updateWidgetLayout(editingWidget.id, updates);
        return;
      }

      updateActiveBoard((board) => ({
        ...board,
        widgets: board.widgets.map((widget) =>
          widget.id === editingWidget.id ? { ...widget, ...updates } : widget,
        ),
      }));
    },
    [editingWidget, updateActiveBoard, updateWidgetLayout],
  );

  const deleteSelectedWidget = useCallback(() => {
    if (!editingWidget) return;
    updateActiveBoard((board) => ({
      ...board,
      widgets: board.widgets.filter((widget) => widget.id !== editingWidget.id),
    }));
    setActiveWidgetId(null);
    setEditingWidgetId(null);
  }, [editingWidget, updateActiveBoard]);

  return {
    updateActiveBoard,
    updateWidgetLayout,
    createBoard,
    addWidget,
    updateSelectedWidget,
    deleteSelectedWidget,
  };
}
