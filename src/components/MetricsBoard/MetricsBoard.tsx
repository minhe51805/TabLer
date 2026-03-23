import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n";
import type {
  MetricsBoardDefinition,
  MetricsWidgetDefinition,
  MetricsWidgetType,
} from "../../types";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  canPlaceWidget,
  clampGridX,
  clampGridY,
  colSpanToWidthPx,
  compactMetricsLabel,
  createBoardDefinition,
  createWidgetDefinition,
  findFirstAvailablePosition,
  getLastPathSegment,
  getWidgetLibrary as _getWidgetLibrary,
  getWidgetLibraryItem as _getWidgetLibraryItem,
  heightPxToRowSpan,
  normalizeWidgetLayout,
  readStoredBoards,
  rowSpanToHeightPx,
  widthPxToColSpan,
  writeStoredBoards,
  type GridPosition,
} from "./utils/query-builder";
import { MetricsWidgetCard as _MetricsWidgetCard } from "./components/MetricsWidget";
import { MetricsEditor as _MetricsEditor } from "./components/MetricsEditor";
import { MetricsBoardSidebar } from "./components/MetricsBoardSidebar";
import { MetricsBoardCanvas } from "./components/MetricsBoardCanvas";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  connectionId: string;
  database?: string;
  tabId?: string;
  boardId?: string;
  integratedSidebar?: boolean;
}

type DragState = {
  widgetId: string;
  startClientX: number;
  startClientY: number;
  originGridX: number;
  originGridY: number;
  previewGridX: number;
  previewGridY: number;
};

type ResizeState = {
  widgetId: string;
  startClientX: number;
  startClientY: number;
  originColSpan: number;
  originRowSpan: number;
  previewColSpan: number;
  previewRowSpan: number;
  originWidthPx: number;
  originHeightPx: number;
  previewWidthPx: number;
  previewHeightPx: number;
};

type CanvasContextMenuState = {
  left: number;
  top: number;
  grid_x: number;
  grid_y: number;
  submenuOpen: boolean;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MetricsBoard({
  connectionId,
  database,
  tabId,
  boardId,
  integratedSidebar = true,
}: Props) {
  const { t } = useI18n();
  const updateTab = useAppStore((state) => state.updateTab);
  const connections = useAppStore((state) => state.connections);
  const [boards, setBoards] = useState<MetricsBoardDefinition[]>([]);
  const [boardSearch, setBoardSearch] = useState("");
  const [activeBoardId, setActiveBoardId] = useState<string | null>(boardId ?? null);
  const [activeWidgetId, setActiveWidgetId] = useState<string | null>(null);
  const [editingWidgetId, setEditingWidgetId] = useState<string | null>(null);
  const [widgetQueryDraft, setWidgetQueryDraft] = useState("");
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenuState | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(1080);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const boardSearchInputRef = useRef<HTMLInputElement | null>(null);

  const activeConnection = useMemo(
    () => connections.find((connection) => connection.id === connectionId) || null,
    [connectionId, connections],
  );

  const persistBoards = useCallback(
    (nextBoards: MetricsBoardDefinition[]) => {
      setBoards(nextBoards);
      const allBoards = readStoredBoards();
      const otherBoards = allBoards.filter((board) => board.connection_id !== connectionId);
      writeStoredBoards([...otherBoards, ...nextBoards]);
      window.dispatchEvent(
        new CustomEvent("metrics-boards-updated", {
          detail: { connectionId },
        }),
      );
    },
    [connectionId],
  );

  useEffect(() => {
    const connectionBoards = readStoredBoards().filter((board) => board.connection_id === connectionId);
    if (connectionBoards.length === 0) {
      const initialBoard = createBoardDefinition(connectionId, database, []);
      persistBoards([initialBoard]);
      setActiveBoardId(initialBoard.id);
      setActiveWidgetId(null);
      setEditingWidgetId(null);
      return;
    }

    setBoards(connectionBoards);
    const nextActiveBoardId =
      (boardId && connectionBoards.some((board) => board.id === boardId) && boardId) ||
      connectionBoards[0].id;
    setActiveBoardId(nextActiveBoardId);
    setActiveWidgetId(null);
    setEditingWidgetId(null);
  }, [boardId, connectionId, database, persistBoards]);

  const filteredBoards = useMemo(() => {
    const query = boardSearch.trim().toLowerCase();
    if (!query) return boards;
    return boards.filter((board) => board.name.toLowerCase().includes(query));
  }, [boardSearch, boards]);

  const activeBoard = useMemo(
    () => boards.find((board) => board.id === activeBoardId) || null,
    [activeBoardId, boards],
  );

  const editingWidget = useMemo(
    () => activeBoard?.widgets.find((widget) => widget.id === editingWidgetId) || null,
    [activeBoard, editingWidgetId],
  );

  const displayDatabaseLabel = useMemo(() => {
    if (!database && !activeBoard?.database) return activeConnection?.name || t("common.database");
    const rawDatabase =
      activeConnection?.db_type === "sqlite"
        ? getLastPathSegment(database || activeBoard?.database)
        : database || activeBoard?.database || "";
    return compactMetricsLabel(rawDatabase || activeConnection?.name || t("common.database"));
  }, [activeBoard?.database, activeConnection?.db_type, activeConnection?.name, database, t]);

  const displayConnectionLabel = useMemo(() => {
    const source =
      activeConnection?.db_type === "sqlite"
        ? `${t("common.file")} workspace`
        : activeConnection?.name || activeConnection?.host || t("workspace.ready.connection");
    return compactMetricsLabel(source, 16);
  }, [activeConnection?.db_type, activeConnection?.host, activeConnection?.name, t]);

  const shouldKeepWidgetSelection = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;

    return Boolean(
      target.closest(".metrics-widget-card") ||
        target.closest(".metrics-widget-editor") ||
        target.closest(".metrics-board-list-child") ||
        target.closest(".metrics-board-context-menu-shell"),
    );
  }, []);

  const clearWidgetSelection = useCallback(() => {
    setActiveWidgetId(null);
    setEditingWidgetId(null);
  }, []);

  const handleWidgetSelection = useCallback((widgetId: string) => {
    setActiveWidgetId((current) => (current === widgetId ? null : widgetId));
    setEditingWidgetId((current) => (current === widgetId ? null : widgetId));
    setCanvasContextMenu(null);
  }, []);

  const handleShellPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if ((!activeWidgetId && !editingWidgetId) || dragState || resizeState) return;
      if (shouldKeepWidgetSelection(event.target)) return;
      clearWidgetSelection();
    },
    [activeWidgetId, clearWidgetSelection, dragState, editingWidgetId, resizeState, shouldKeepWidgetSelection],
  );

  useEffect(() => {
    if (!activeBoard) return;
    if (activeWidgetId && !activeBoard.widgets.some((widget) => widget.id === activeWidgetId)) {
      setActiveWidgetId(null);
    }
    if (editingWidgetId && !activeBoard.widgets.some((widget) => widget.id === editingWidgetId)) {
      setEditingWidgetId(null);
    }
  }, [activeBoard, activeWidgetId, editingWidgetId]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const updateCanvasWidth = () => {
      setCanvasWidth(Math.max(element.clientWidth - 36, 1080));
    };

    updateCanvasWidth();

    const observer = new ResizeObserver(() => {
      updateCanvasWidth();
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!tabId || !activeBoard) return;
    updateTab(tabId, { metricsBoardId: activeBoard.id, title: activeBoard.name });
  }, [activeBoard, tabId, updateTab]);

  useEffect(() => {
    const handleFocusMetricsWidget = (
      event: Event,
    ) => {
      const detail = (event as CustomEvent<{ boardId?: string; widgetId?: string }>).detail;
      if (!detail?.widgetId) return;

      if (detail.boardId && detail.boardId !== activeBoardId) {
      setActiveBoardId(detail.boardId);
      }

      setActiveWidgetId(detail.widgetId);
      setEditingWidgetId(detail.widgetId);
      setCanvasContextMenu(null);
    };

    window.addEventListener("focus-metrics-widget", handleFocusMetricsWidget);
    return () => window.removeEventListener("focus-metrics-widget", handleFocusMetricsWidget);
  }, [activeBoardId]);

  const surfaceWidth = useMemo(
    () => Math.max(canvasWidth, 1080),
    [canvasWidth],
  );
  const columnWidth = useMemo(
    () => (surfaceWidth - 12 * 11) / 12,
    [surfaceWidth],
  );
  const rowUnit = 82 + 12;
  const colUnit = columnWidth + 12;
  const surfaceHeight = useMemo(() => {
    const occupiedRows = activeBoard
      ? activeBoard.widgets.reduce((max, widget) => {
          const previewGridY =
            dragState && dragState.widgetId === widget.id ? dragState.previewGridY : widget.grid_y;
          if (resizeState && resizeState.widgetId === widget.id) {
            const bottomPx = previewGridY * rowUnit + resizeState.previewHeightPx;
            const rowCount = Math.ceil((bottomPx + 12) / rowUnit);
            return Math.max(max, rowCount);
          }
          return Math.max(max, previewGridY + widget.row_span);
        }, 8)
      : 8;
    return occupiedRows * 82 + Math.max(occupiedRows - 1, 0) * 12;
  }, [activeBoard, dragState, resizeState]);

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
        const currentWidget = board.widgets.find((widget) => widget.id === widgetId);
        if (!currentWidget) return board;

        const others = board.widgets.filter((widget) => widget.id !== widgetId);
        const candidate = normalizeWidgetLayout({ ...currentWidget, ...updates });
        const positioned = canPlaceWidget(others, candidate, widgetId)
          ? candidate
          : { ...candidate, ...findFirstAvailablePosition(others, candidate) };

        return {
          ...board,
          widgets: board.widgets.map((widget) => (widget.id === widgetId ? positioned : widget)),
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

  const handleOpenDatabaseSidebar = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("open-left-sidebar-panel", {
        detail: {
          panel: "database",
          focusSearch: true,
        },
      }),
    );
  }, []);

  const handleFocusMetricsSidebar = useCallback(() => {
    boardSearchInputRef.current?.focus();
    boardSearchInputRef.current?.select();
  }, []);

  const addWidget = useCallback(
    (type: MetricsWidgetType, preferredPosition?: Partial<GridPosition>) => {
      if (!activeBoard) return;
      const nextWidget = createWidgetDefinition(type, activeBoard.widgets, preferredPosition);
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

  useEffect(() => {
    if (!canvasContextMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".metrics-board-context-menu-shell")) return;
      setCanvasContextMenu(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCanvasContextMenu(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [canvasContextMenu]);

  useEffect(() => {
    if (!editingWidget) return;
    if (widgetQueryDraft === editingWidget.query) return;

    const timer = window.setTimeout(() => {
      updateSelectedWidget({ query: widgetQueryDraft });
    }, 160);

    return () => {
      window.clearTimeout(timer);
    };
  }, [editingWidget, updateSelectedWidget, widgetQueryDraft]);

  const getWidgetLayoutMetrics = useCallback(
    (widget: MetricsWidgetDefinition) => {
      const dragPreview =
        dragState && dragState.widgetId === widget.id
          ? { grid_x: dragState.previewGridX, grid_y: dragState.previewGridY }
          : null;
      const gridX = dragPreview?.grid_x ?? widget.grid_x;
      const gridY = dragPreview?.grid_y ?? widget.grid_y;
      const widthPx =
        resizeState && resizeState.widgetId === widget.id
          ? resizeState.previewWidthPx
          : colSpanToWidthPx(widget.col_span, columnWidth);
      const heightPx =
        resizeState && resizeState.widgetId === widget.id
          ? resizeState.previewHeightPx
          : rowSpanToHeightPx(widget.row_span);

      return {
        left: gridX * colUnit,
        top: gridY * rowUnit,
        width: widthPx,
        height: heightPx,
      };
    },
    [colUnit, columnWidth, dragState, resizeState, rowUnit],
  );

  const getWidgetLayoutStyle = useCallback(
    (widget: MetricsWidgetDefinition): CSSProperties => {
      const rect = getWidgetLayoutMetrics(widget);

      return {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      };
    },
    [getWidgetLayoutMetrics],
  );

  const widgetEditorLayout = useMemo(() => {
    if (!editingWidget) return null;

    const rect = getWidgetLayoutMetrics(editingWidget);
    const editorWidth = Math.min(
      320,
      Math.max(272, surfaceWidth - 28),
    );
    const rightCandidate = rect.left + rect.width + 18;
    const canPlaceRight = rightCandidate + editorWidth <= surfaceWidth;
    const leftCandidate = rect.left - editorWidth - 18;
    const left = canPlaceRight
      ? rightCandidate
      : Math.max(12, Math.min(leftCandidate, surfaceWidth - editorWidth - 12));
    const top = Math.max(
      12,
      Math.min(rect.top, surfaceHeight - 372 - 12),
    );

    return {
      left,
      top,
      width: editorWidth,
      height: 372,
      side: canPlaceRight ? "right" : "left",
    } as const;
  }, [editingWidget, getWidgetLayoutMetrics, surfaceHeight, surfaceWidth]);

  const openCanvasContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!activeBoard) return;
      if (dragState || resizeState) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(".metrics-widget-card") ||
        target?.closest(".metrics-widget-editor") ||
        target?.closest(".metrics-board-context-menu-shell")
      ) {
        return;
      }

      event.preventDefault();
      const canvasElement = canvasRef.current;
      if (!canvasElement) return;

      const canvasRect = canvasElement.getBoundingClientRect();
      const localX = canvasElement.scrollLeft + event.clientX - canvasRect.left;
      const localY = canvasElement.scrollTop + event.clientY - canvasRect.top;
      const triggerWidth = 96;
      const menuWidth = 176;
      const totalWidth = triggerWidth + 8 + menuWidth;
      const maxLeft = Math.max(16, surfaceWidth - totalWidth - 16);
      const maxTop = Math.max(16, surfaceHeight - 48 - 16);
      const left = Math.max(16, Math.min(localX, maxLeft));
      const top = Math.max(16, Math.min(localY, maxTop));

      clearWidgetSelection();
      setCanvasContextMenu({
        left,
        top,
        grid_x: clampGridX(Math.floor(localX / colUnit), 4),
        grid_y: clampGridY(Math.floor(localY / rowUnit)),
        submenuOpen: false,
      });
    },
    [activeBoard, clearWidgetSelection, colUnit, dragState, resizeState, rowUnit, surfaceHeight, surfaceWidth],
  );

  const surfaceContentHeight = useMemo(() => {
    if (!widgetEditorLayout) return surfaceHeight;
    return Math.max(surfaceHeight, widgetEditorLayout.top + widgetEditorLayout.height + 16);
  }, [surfaceHeight, widgetEditorLayout]);

  const handleWidgetDragStart = useCallback(
    (widget: MetricsWidgetDefinition, clientX: number, clientY: number) => {
      setActiveWidgetId(widget.id);
      setEditingWidgetId(null);
      setResizeState(null);
      setDragState({
        widgetId: widget.id,
        startClientX: clientX,
        startClientY: clientY,
        originGridX: widget.grid_x,
        originGridY: widget.grid_y,
        previewGridX: widget.grid_x,
        previewGridY: widget.grid_y,
      });
    },
    [],
  );

  const handleWidgetResizeStart = useCallback(
    (widget: MetricsWidgetDefinition, clientX: number, clientY: number) => {
      const originWidthPx = colSpanToWidthPx(widget.col_span, columnWidth);
      const originHeightPx = rowSpanToHeightPx(widget.row_span);
      setActiveWidgetId(widget.id);
      setEditingWidgetId(null);
      setDragState(null);
      setResizeState({
        widgetId: widget.id,
        startClientX: clientX,
        startClientY: clientY,
        originColSpan: widget.col_span,
        originRowSpan: widget.row_span,
        previewColSpan: widget.col_span,
        previewRowSpan: widget.row_span,
        originWidthPx,
        originHeightPx,
        previewWidthPx: originWidthPx,
        previewHeightPx: originHeightPx,
      });
    },
    [columnWidth],
  );

  useEffect(() => {
    if (!dragState || !activeBoard) return;

    const activeWidget = activeBoard.widgets.find((widget) => widget.id === dragState.widgetId);
    if (!activeWidget) return;

    const handlePointerMove = (event: PointerEvent) => {
      const deltaColumns = Math.round((event.clientX - dragState.startClientX) / colUnit);
      const deltaRows = Math.round((event.clientY - dragState.startClientY) / rowUnit);
      const nextGridX = clampGridX(dragState.originGridX + deltaColumns, activeWidget.col_span);
      const nextGridY = clampGridY(dragState.originGridY + deltaRows);

      setDragState((current) => {
        if (!current || current.widgetId !== dragState.widgetId) return current;
        if (current.previewGridX === nextGridX && current.previewGridY === nextGridY) return current;
        return {
          ...current,
          previewGridX: nextGridX,
          previewGridY: nextGridY,
        };
      });
    };

    const finishDrag = () => {
      setDragState((current) => {
        if (!current || current.widgetId !== dragState.widgetId) return null;

        const candidate = normalizeWidgetLayout({
          ...activeWidget,
          grid_x: current.previewGridX,
          grid_y: current.previewGridY,
        });
        const others = activeBoard.widgets.filter((widget) => widget.id !== activeWidget.id);
        if (canPlaceWidget(others, candidate, activeWidget.id)) {
          updateWidgetLayout(activeWidget.id, {
            grid_x: candidate.grid_x,
            grid_y: candidate.grid_y,
          });
        }

        return null;
      });
    };

    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishDrag, { once: true });
    window.addEventListener("pointercancel", finishDrag, { once: true });

    return () => {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
    };
  }, [activeBoard, colUnit, dragState, rowUnit, updateWidgetLayout]);

  useEffect(() => {
    if (!resizeState || !activeBoard) return;

    const activeWidget = activeBoard.widgets.find((widget) => widget.id === resizeState.widgetId);
    if (!activeWidget) return;

    const others = activeBoard.widgets.filter((widget) => widget.id !== activeWidget.id);

    const handlePointerMove = (event: PointerEvent) => {
      const maxColSpan = Math.max(3, 12 - activeWidget.grid_x);
      const minWidthPx = colSpanToWidthPx(3, columnWidth);
      const maxWidthPx = colSpanToWidthPx(maxColSpan, columnWidth);
      const minHeightPx = rowSpanToHeightPx(2);
      const maxHeightPx = rowSpanToHeightPx(6);
      const nextWidthPx = Math.min(
        maxWidthPx,
        Math.max(minWidthPx, resizeState.originWidthPx + (event.clientX - resizeState.startClientX)),
      );
      const nextHeightPx = Math.min(
        maxHeightPx,
        Math.max(minHeightPx, resizeState.originHeightPx + (event.clientY - resizeState.startClientY)),
      );
      const nextColSpan = widthPxToColSpan(nextWidthPx, columnWidth);
      const nextRowSpan = heightPxToRowSpan(nextHeightPx);

      setResizeState((current) => {
        if (!current || current.widgetId !== resizeState.widgetId) return current;
        if (
          current.previewColSpan === nextColSpan &&
          current.previewRowSpan === nextRowSpan &&
          current.previewWidthPx === nextWidthPx &&
          current.previewHeightPx === nextHeightPx
        ) {
          return current;
        }
        return {
          ...current,
          previewColSpan: nextColSpan,
          previewRowSpan: nextRowSpan,
          previewWidthPx: nextWidthPx,
          previewHeightPx: nextHeightPx,
        };
      });
    };

    const finishResize = () => {
      setResizeState((current) => {
        if (!current || current.widgetId !== resizeState.widgetId) return null;
        const candidate = normalizeWidgetLayout({
          ...activeWidget,
          col_span: current.previewColSpan,
          row_span: current.previewRowSpan,
        });

        if (canPlaceWidget(others, candidate, activeWidget.id)) {
          updateWidgetLayout(activeWidget.id, {
            col_span: candidate.col_span,
            row_span: candidate.row_span,
          });
        }

        return null;
      });
    };

    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize, { once: true });
    window.addEventListener("pointercancel", finishResize, { once: true });

    return () => {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
  }, [activeBoard, columnWidth, resizeState, updateWidgetLayout]);

  return (
    <div
      className={`metrics-board-shell ${integratedSidebar ? "" : "canvas-only"}`}
      onPointerDownCapture={handleShellPointerDownCapture}
    >
      {integratedSidebar && (
        <MetricsBoardSidebar
          displayDatabaseLabel={displayDatabaseLabel}
          displayConnectionLabel={displayConnectionLabel}
          boards={boards}
          filteredBoards={filteredBoards}
          activeBoardId={activeBoardId}
          activeWidgetId={activeWidgetId}
          boardSearch={boardSearch}
          onBoardSearchChange={setBoardSearch}
          onCreateBoard={createBoard}
          onSelectBoard={setActiveBoardId}
          onSelectWidget={handleWidgetSelection}
          onOpenDatabaseSidebar={handleOpenDatabaseSidebar}
          onFocusMetricsSidebar={handleFocusMetricsSidebar}
        />
      )}

      <div className="metrics-board-main">
        <MetricsBoardCanvas
          connectionId={connectionId}
          activeBoard={activeBoard}
          activeWidgetId={activeWidgetId}
          editingWidget={editingWidget}
          setWidgetQueryDraft={setWidgetQueryDraft}
          canvasContextMenu={canvasContextMenu}
          dragState={dragState}
          resizeState={resizeState}
          surfaceWidth={surfaceWidth}
          surfaceContentHeight={surfaceContentHeight}
          canvasRef={canvasRef}
          getWidgetLayoutStyle={getWidgetLayoutStyle}
          handleWidgetSelection={handleWidgetSelection}
          handleWidgetDragStart={handleWidgetDragStart}
          handleWidgetResizeStart={handleWidgetResizeStart}
          openCanvasContextMenu={openCanvasContextMenu}
          addWidget={addWidget}
          updateSelectedWidget={updateSelectedWidget}
          clearWidgetSelection={clearWidgetSelection}
          deleteSelectedWidget={deleteSelectedWidget}
          widgetQueryDraft={widgetQueryDraft}
          widgetEditorLayout={widgetEditorLayout}
          setCanvasContextMenu={setCanvasContextMenu}
        />
      </div>
    </div>
  );
}
