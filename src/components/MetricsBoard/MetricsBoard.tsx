import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Sparkles,
  ChevronDown,
  LayoutGrid,
  LayoutTemplate,
  MoreHorizontal,
  Copy,
  Download,
  Upload,
  RefreshCw,
} from "lucide-react";
import { useConnectionStore } from "../../stores/connectionStore";
import { useUIStore } from "../../stores/uiStore";
import { useI18n } from "../../i18n";
import { buildMetricsBoardAttachmentSnapshot } from "./metrics-board-attachment";
import {
  useMetricsBoardWidgets,
  type CanvasContextMenuState,
} from "./hooks/useMetricsBoardWidgets";
import type { MetricsBoardDefinition, MetricsWidgetDefinition, QueryResult } from "../../types";
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
  getLastPathSegment,
  getWidgetLibrary as _getWidgetLibrary,
  getWidgetLibraryItem as _getWidgetLibraryItem,
  METRICS_EDITOR_ESTIMATED_HEIGHT,
  METRICS_EDITOR_GAP,
  METRICS_EDITOR_MAX_WIDTH,
  METRICS_EDITOR_MIN_WIDTH,
  METRICS_GRID_COLUMNS,
  heightPxToRowSpan,
  METRICS_GRID_GAP,
  METRICS_GRID_MIN_ROWS,
  METRICS_GRID_MIN_WIDTH,
  METRICS_GRID_ROW_HEIGHT,
  normalizeWidgetLayout,
  getSeriesLabelColumn,
  WIDGET_TEMPLATES,
  duplicateBoardDefinition,
  serializeBoard,
  deserializeBoard,
  downloadTextFile,
  readStoredBoards,
  rowSpanToHeightPx,
  widthPxToColSpan,
  writeStoredBoards,
} from "./utils/query-builder";
import { MetricsWidgetCard } from "./components/MetricsWidget";
import { MetricsBoardSidebar } from "./components/MetricsBoardSidebar";
import { MetricsBoardCanvas } from "./components/MetricsBoardCanvas";
import { formatRelativeTime } from "./utils/metrics-board-io";

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
  const { language, t } = useI18n();
  const updateTab = useUIStore((state) => state.updateTab);
  const addTab = useUIStore((state) => state.addTab);
  const setActiveTab = useUIStore((state) => state.setActiveTab);
  const connections = useConnectionStore((state) => state.connections);
  const [boards, setBoards] = useState<MetricsBoardDefinition[]>([]);
  const [boardSearch, setBoardSearch] = useState("");
  const [isWidgetMenuOpen, setIsWidgetMenuOpen] = useState(false);
  const widgetMenuRef = useRef<HTMLDivElement | null>(null);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(boardId ?? null);
  const [activeWidgetId, setActiveWidgetId] = useState<string | null>(null);
  const [editingWidgetId, setEditingWidgetId] = useState<string | null>(null);
  const [widgetQueryDraft, setWidgetQueryDraft] = useState("");
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenuState | null>(null);
  const [isRenamingBoard, setIsRenamingBoard] = useState(false);
  const [boardRenameValue, setBoardRenameValue] = useState("");
  const [widgetContextMenu, setWidgetContextMenu] = useState<{
    widgetId: string;
    left: number;
    top: number;
    submenu: "type" | "refresh" | null;
  } | null>(null);
  const [undoDelete, setUndoDelete] = useState<{
    widget: MetricsWidgetDefinition;
    expiresAt: number;
  } | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);

  // Track the most recent widget refresh across the board.
  const handleWidgetRefreshed = useCallback(() => setLastRefreshAt(Date.now()), []);

  const [dragState, setDragState] = useState<DragState | null>(null);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(1080);
  const [pendingFocusTarget, setPendingFocusTarget] = useState<{
    boardId?: string;
    widgetId: string;
  } | null>(null);
  const [isBoardMenuOpen, setIsBoardMenuOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [fullscreenWidgetId, setFullscreenWidgetId] = useState<string | null>(null);
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
    const connectionBoards = readStoredBoards().filter(
      (board) => board.connection_id === connectionId,
    );
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

  useEffect(() => {
    const handleBoardsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ connectionId?: string }>).detail;
      if (detail?.connectionId && detail.connectionId !== connectionId) {
        return;
      }

      const connectionBoards = readStoredBoards().filter(
        (board) => board.connection_id === connectionId,
      );
      setBoards(connectionBoards);

      setActiveBoardId((current) => {
        if (current && connectionBoards.some((board) => board.id === current)) {
          return current;
        }
        if (boardId && connectionBoards.some((board) => board.id === boardId)) {
          return boardId;
        }
        return connectionBoards[0]?.id ?? null;
      });
    };

    window.addEventListener("metrics-boards-updated", handleBoardsUpdated);
    return () => window.removeEventListener("metrics-boards-updated", handleBoardsUpdated);
  }, [boardId, connectionId]);

  const filteredBoards = useMemo(() => {
    const query = boardSearch.trim().toLowerCase();
    if (!query) return boards;
    return boards.filter(
      (board) =>
        board.name.toLowerCase().includes(query) ||
        board.widgets.some(
          (w) =>
            w.title.toLowerCase().includes(query) ||
            (w.note ?? "").toLowerCase().includes(query) ||
            w.query.toLowerCase().includes(query),
        ),
    );
  }, [boardSearch, boards]);

  const activeBoard = useMemo(
    () => boards.find((board) => board.id === activeBoardId) || null,
    [activeBoardId, boards],
  );
  const widgetLibrary = useMemo(() => _getWidgetLibrary(), []);

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
    [
      activeWidgetId,
      clearWidgetSelection,
      dragState,
      editingWidgetId,
      resizeState,
      shouldKeepWidgetSelection,
    ],
  );

  useEffect(() => {
    if (!isWidgetMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (widgetMenuRef.current && !widgetMenuRef.current.contains(event.target as Node)) {
        setIsWidgetMenuOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsWidgetMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isWidgetMenuOpen]);

  useEffect(() => {
    if (!activeBoard) return;
    if (activeWidgetId && !activeBoard.widgets.some((widget) => widget.id === activeWidgetId)) {
      if (pendingFocusTarget?.widgetId !== activeWidgetId) {
        setActiveWidgetId(null);
      }
    }
    if (editingWidgetId && !activeBoard.widgets.some((widget) => widget.id === editingWidgetId)) {
      if (pendingFocusTarget?.widgetId !== editingWidgetId) {
        setEditingWidgetId(null);
      }
    }
  }, [activeBoard, activeWidgetId, editingWidgetId, pendingFocusTarget]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const updateCanvasWidth = () => {
      setCanvasWidth(Math.max(element.clientWidth - 32, METRICS_GRID_MIN_WIDTH));
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
    updateTab(tabId, {
      metricsBoardId: activeBoard.id,
      title: activeBoard.name,
    });
  }, [activeBoard, tabId, updateTab]);

  useEffect(() => {
    const handleFocusMetricsWidget = (event: Event) => {
      const detail = (event as CustomEvent<{ boardId?: string; widgetId?: string }>).detail;
      if (!detail?.widgetId) return;

      if (detail.boardId && detail.boardId !== activeBoardId) {
        setActiveBoardId(detail.boardId);
      }

      setPendingFocusTarget({
        boardId: detail.boardId,
        widgetId: detail.widgetId,
      });
      setActiveWidgetId(detail.widgetId);
      setEditingWidgetId(detail.widgetId);
      setCanvasContextMenu(null);
    };

    window.addEventListener("focus-metrics-widget", handleFocusMetricsWidget);
    return () => window.removeEventListener("focus-metrics-widget", handleFocusMetricsWidget);
  }, [activeBoardId]);

  useEffect(() => {
    if (!pendingFocusTarget?.widgetId || !activeBoard) return;
    if (pendingFocusTarget.boardId && pendingFocusTarget.boardId !== activeBoard.id) return;

    const focusedWidget = activeBoard.widgets.find(
      (widget) => widget.id === pendingFocusTarget.widgetId,
    );
    if (!focusedWidget) return;

    setActiveWidgetId(focusedWidget.id);
    setEditingWidgetId(focusedWidget.id);
    setPendingFocusTarget(null);
  }, [activeBoard, pendingFocusTarget]);

  useEffect(() => {
    if (!activeWidgetId || !activeBoard) return;

    const activeWidget = activeBoard.widgets.find((widget) => widget.id === activeWidgetId);
    const canvasElement = canvasRef.current;
    if (!activeWidget || !canvasElement) return;

    const scrollToWidget = () => {
      const rowUnit = METRICS_GRID_ROW_HEIGHT + METRICS_GRID_GAP;
      const top = activeWidget.grid_y * rowUnit;
      const height = rowSpanToHeightPx(activeWidget.row_span);
      const padding = 20;

      const maxTop = Math.max(0, top - padding);
      const currentTop = canvasElement.scrollTop;
      const currentBottom = currentTop + canvasElement.clientHeight;
      const widgetBottom = top + height + padding;
      const widgetVisible = maxTop >= currentTop && widgetBottom <= currentBottom;

      if (!widgetVisible) {
        canvasElement.scrollTo({
          top: maxTop,
          behavior: "smooth",
        });
      }

      const widgetElement = canvasElement.querySelector<HTMLElement>(
        `[data-metrics-widget-id="${activeWidget.id}"]`,
      );
      if (widgetElement) {
        widgetElement.scrollIntoView({
          block: "nearest",
          inline: "nearest",
          behavior: "smooth",
        });
      }
    };

    let attemptCount = 0;
    let rafId = 0;
    let timeoutId = 0;

    const scheduleScroll = () => {
      rafId = window.requestAnimationFrame(() => {
        scrollToWidget();
        const widgetElement = canvasElement.querySelector<HTMLElement>(
          `[data-metrics-widget-id="${activeWidget.id}"]`,
        );
        if (!widgetElement && attemptCount < 8) {
          attemptCount += 1;
          timeoutId = window.setTimeout(scheduleScroll, 50);
        }
      });
    };

    scheduleScroll();

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timeoutId);
    };
  }, [activeBoard, activeWidgetId]);

  const surfaceWidth = useMemo(() => Math.max(canvasWidth, METRICS_GRID_MIN_WIDTH), [canvasWidth]);
  const columnWidth = useMemo(
    () => (surfaceWidth - METRICS_GRID_GAP * (METRICS_GRID_COLUMNS - 1)) / METRICS_GRID_COLUMNS,
    [surfaceWidth],
  );
  const rowUnit = METRICS_GRID_ROW_HEIGHT + METRICS_GRID_GAP;
  const colUnit = columnWidth + METRICS_GRID_GAP;
  const surfaceHeight = useMemo(() => {
    const occupiedRows = activeBoard
      ? activeBoard.widgets.reduce((max, widget) => {
          const previewGridY =
            dragState && dragState.widgetId === widget.id ? dragState.previewGridY : widget.grid_y;
          if (resizeState && resizeState.widgetId === widget.id) {
            const bottomPx = previewGridY * rowUnit + resizeState.previewHeightPx;
            const rowCount = Math.ceil((bottomPx + METRICS_GRID_GAP) / rowUnit);
            return Math.max(max, rowCount);
          }
          return Math.max(max, previewGridY + widget.row_span);
        }, METRICS_GRID_MIN_ROWS)
      : METRICS_GRID_MIN_ROWS;
    return (
      occupiedRows * METRICS_GRID_ROW_HEIGHT + Math.max(occupiedRows - 1, 0) * METRICS_GRID_GAP
    );
  }, [activeBoard, dragState, resizeState, rowUnit]);

  const {
    updateWidgetLayout,
    createBoard,
    addWidget,
    updateSelectedWidget,
    deleteSelectedWidget,
    updateWidgetById,
    duplicateWidget,
    deleteWidgetById,
    restoreWidget,
  } = useMetricsBoardWidgets({
    connectionId,
    database: database || undefined,
    boards,
    activeBoard,
    editingWidget,
    persistBoards,
    setActiveBoardId,
    setActiveWidgetId,
    setEditingWidgetId,
    setCanvasContextMenu,
  });

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

  const handleAttachBoardToAI = useCallback(() => {
    if (!activeBoard) return;

    const attachmentText = buildMetricsBoardAttachmentSnapshot({
      board: activeBoard,
      connectionLabel: displayConnectionLabel,
      databaseLabel: displayDatabaseLabel,
    });

    window.dispatchEvent(
      new CustomEvent("open-ai-slide-panel", {
        detail: {
          attachment: {
            text: attachmentText,
            source:
              language === "vi"
                ? `Dashboard: ${activeBoard.name}`
                : `Dashboard: ${activeBoard.name}`,
            boardId: activeBoard.id,
          },
        },
      }),
    );
  }, [activeBoard, displayConnectionLabel, displayDatabaseLabel, language]);

  const openWidgetResult = useCallback(
    (widget: MetricsWidgetDefinition, result: QueryResult) => {
      const id = `metrics-result-${crypto.randomUUID()}`;
      addTab({
        id,
        type: "table",
        title: `${widget.title || "Metric"} result`,
        connectionId,
        database: database || activeBoard?.database,
        content: widget.query,
        queryResult: result,
      });
      setActiveTab(id);
    },
    [activeBoard?.database, addTab, connectionId, database, setActiveTab],
  );

  const openWidgetQuery = useCallback(
    (widget: MetricsWidgetDefinition) => {
      const id = `metrics-query-${crypto.randomUUID()}`;
      addTab({
        id,
        type: "query",
        title: `${widget.title || "Metric"} SQL`,
        connectionId,
        database: database || activeBoard?.database,
        content: widget.query,
      });
      setActiveTab(id);
    },
    [activeBoard?.database, addTab, connectionId, database, setActiveTab],
  );

  /** Click a chart slice/bar/point: SQL engines get a filtered query tab,
   * document/KV engines open the aggregated result instead. */
  const drillDownWidget = useCallback(
    (widget: MetricsWidgetDefinition, label: string, result: QueryResult) => {
      const isSqlEngine =
        activeConnection?.db_type !== "mongodb" && activeConnection?.db_type !== "redis";
      if (!isSqlEngine) {
        openWidgetResult(widget, result);
        return;
      }
      const labelColumn = getSeriesLabelColumn(result);
      const escaped = label.replace(/'/g, "''");
      const drillSql = labelColumn
        ? `SELECT * FROM (\n${widget.query.trim().replace(/;+\s*$/, "")}\n) AS drilldown WHERE "${labelColumn}" = '${escaped}'`
        : widget.query;
      const id = `metrics-drill-${crypto.randomUUID()}`;
      addTab({
        id,
        type: "query",
        title: `${widget.title || "Metric"}: ${label}`,
        connectionId,
        database: database || activeBoard?.database,
        content: drillSql,
      });
      setActiveTab(id);
    },
    [
      activeBoard?.database,
      activeConnection?.db_type,
      addTab,
      connectionId,
      database,
      openWidgetResult,
      setActiveTab,
    ],
  );

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

  // Widget context menu: dismiss on outside click / Escape.
  useEffect(() => {
    if (!widgetContextMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".metrics-widget-context-menu")) return;
      setWidgetContextMenu(null);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWidgetContextMenu(null);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [widgetContextMenu]);

  const openWidgetContextMenu = useCallback(
    (widgetId: string, clientX: number, clientY: number) => {
      const canvasElement = canvasRef.current;
      if (!canvasElement) return;
      const canvasRect = canvasElement.getBoundingClientRect();
      const localX = canvasElement.scrollLeft + clientX - canvasRect.left;
      const localY = canvasElement.scrollTop + clientY - canvasRect.top;
      setWidgetContextMenu({
        widgetId,
        left: Math.max(8, Math.min(localX, surfaceWidth - 200)),
        top: Math.max(8, Math.min(localY, surfaceHeight - 240)),
        submenu: null,
      });
      setCanvasContextMenu(null);
    },
    [surfaceHeight, surfaceWidth],
  );

  const deleteWidgetWithUndo = useCallback(
    (widgetId: string) => {
      const widget = activeBoard?.widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      deleteWidgetById(widgetId);
      setUndoDelete({ widget, expiresAt: Date.now() + 6000 });
    },
    [activeBoard, deleteWidgetById],
  );

  // Undo toast auto-dismiss.
  useEffect(() => {
    if (!undoDelete) return;
    const remaining = undoDelete.expiresAt - Date.now();
    const timer = window.setTimeout(() => setUndoDelete(null), Math.max(remaining, 0));
    return () => window.clearTimeout(timer);
  }, [undoDelete]);

  // Keyboard: Delete removes the selected widget, Ctrl/Cmd+D duplicates it.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true], .monaco-editor")) {
        return;
      }
      if (!activeWidgetId) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteWidgetWithUndo(activeWidgetId);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateWidget(activeWidgetId);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeWidgetId, deleteWidgetWithUndo, duplicateWidget]);

  // Keyboard: arrows move the selected widget one grid cell.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true], .monaco-editor")) {
        return;
      }
      if (!activeWidgetId || !activeBoard) return;
      const widget = activeBoard.widgets.find((w) => w.id === activeWidgetId);
      if (!widget) return;
      const moves: Record<string, { dx: number; dy: number }> = {
        ArrowLeft: { dx: -1, dy: 0 },
        ArrowRight: { dx: 1, dy: 0 },
        ArrowUp: { dx: 0, dy: -1 },
        ArrowDown: { dx: 0, dy: 1 },
      };
      const move = moves[event.key];
      if (!move) return;
      event.preventDefault();
      updateWidgetLayout(widget.id, {
        grid_x: Math.max(0, widget.grid_x + move.dx),
        grid_y: Math.max(0, widget.grid_y + move.dy),
      });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeWidgetId, activeBoard, updateWidgetLayout]);

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
      METRICS_EDITOR_MAX_WIDTH,
      Math.max(METRICS_EDITOR_MIN_WIDTH, surfaceWidth - 28),
    );
    const rightCandidate = rect.left + rect.width + METRICS_EDITOR_GAP;
    const canPlaceRight = rightCandidate + editorWidth <= surfaceWidth;
    const leftCandidate = rect.left - editorWidth - METRICS_EDITOR_GAP;
    const left = canPlaceRight
      ? rightCandidate
      : Math.max(
          METRICS_GRID_GAP,
          Math.min(leftCandidate, surfaceWidth - editorWidth - METRICS_GRID_GAP),
        );
    const top = Math.max(
      METRICS_GRID_GAP,
      Math.min(rect.top, surfaceHeight - METRICS_EDITOR_ESTIMATED_HEIGHT - METRICS_GRID_GAP),
    );

    return {
      left,
      top,
      width: editorWidth,
      height: METRICS_EDITOR_ESTIMATED_HEIGHT,
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
    [
      activeBoard,
      clearWidgetSelection,
      colUnit,
      dragState,
      resizeState,
      rowUnit,
      surfaceHeight,
      surfaceWidth,
    ],
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
        if (current.previewGridX === nextGridX && current.previewGridY === nextGridY)
          return current;
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
        Math.max(
          minWidthPx,
          resizeState.originWidthPx + (event.clientX - resizeState.startClientX),
        ),
      );
      const nextHeightPx = Math.min(
        maxHeightPx,
        Math.max(
          minHeightPx,
          resizeState.originHeightPx + (event.clientY - resizeState.startClientY),
        ),
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
          onReorderWidgets={(boardId, widgetIds) => {
            persistBoards(
              boards.map((b) =>
                b.id === boardId
                  ? {
                      ...b,
                      widgets: widgetIds
                        .map((id) => b.widgets.find((w) => w.id === id))
                        .filter((w): w is MetricsWidgetDefinition => !!w),
                    }
                  : b,
              ),
            );
          }}
        />
      )}

      <div className="metrics-board-main">
        <div className="metrics-board-topbar">
          <div className="metrics-board-topbar-copy">
            <span className="metrics-board-topbar-kicker">{t("metrics.sidebarKicker")}</span>
            {isRenamingBoard && activeBoard ? (
              <input
                className="metrics-board-rename-input"
                value={boardRenameValue}
                onChange={(e) => setBoardRenameValue(e.target.value)}
                onBlur={() => {
                  const name = boardRenameValue.trim();
                  if (name && name !== activeBoard.name) {
                    persistBoards(
                      boards.map((b) => (b.id === activeBoard.id ? { ...b, name } : b)),
                    );
                  }
                  setIsRenamingBoard(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setIsRenamingBoard(false);
                }}
                autoFocus
              />
            ) : (
              <strong
                className="metrics-board-topbar-title"
                onDoubleClick={() => {
                  if (activeBoard) {
                    setBoardRenameValue(activeBoard.name);
                    setIsRenamingBoard(true);
                  }
                }}
                title={t("metrics.renameBoardHint")}
              >
                {activeBoard?.name || t("metrics.createBoard")}
              </strong>
            )}
            <span className="metrics-board-topbar-meta">
              {displayConnectionLabel}
              {displayDatabaseLabel ? ` / ${displayDatabaseLabel}` : ""}
            </span>
            {activeBoard && (
              <span className="metrics-board-topbar-stats">
                {activeBoard.widgets.length} {t("metrics.widgets")}
                {lastRefreshAt
                  ? ` · ${t("metrics.lastRefresh")} ${formatRelativeTime(lastRefreshAt)}`
                  : ""}
              </span>
            )}
          </div>

          <div className="metrics-board-topbar-actions">
            <button
              type="button"
              className="metrics-board-topbar-action"
              onClick={handleAttachBoardToAI}
              title={
                language === "vi"
                  ? "Dinh kem dashboard vao AI chat"
                  : "Attach this dashboard to AI chat"
              }
              disabled={!activeBoard}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{language === "vi" ? "Gan vao AI" : "Attach to AI"}</span>
            </button>
            <button
              type="button"
              className="metrics-board-topbar-action metrics-board-topbar-action--primary"

              onClick={createBoard}
              title={t("metrics.createBoard")}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t("metrics.createBoard")}</span>
            </button>
            <div className="metrics-board-widget-menu">
              <button
                type="button"
                className="metrics-board-topbar-action"
                onClick={() => setIsBoardMenuOpen((v) => !v)}
                disabled={!activeBoard}
                aria-haspopup="menu"
                aria-expanded={isBoardMenuOpen}
                title={t("metrics.boardActions")}
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
              {isBoardMenuOpen && (
                <div className="metrics-board-widget-menu-list" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="metrics-board-widget-menu-item"
                    onClick={() => {
                      if (activeBoard) {
                        const copy = duplicateBoardDefinition(activeBoard, boards);
                        persistBoards([copy, ...boards]);
                        setActiveBoardId(copy.id);
                      }
                      setIsBoardMenuOpen(false);
                    }}
                  >
                    <Copy className="w-3.5 h-3.5 metrics-board-widget-menu-icon" />
                    <span className="metrics-board-widget-menu-copy">
                      <strong>{t("metrics.boardDuplicate")}</strong>
                      <small>{t("metrics.boardDuplicateDesc")}</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="metrics-board-widget-menu-item"
                    onClick={() => {
                      if (activeBoard) {
                        downloadTextFile(
                          serializeBoard(activeBoard),
                          `${activeBoard.name}.tabler-board.json`,
                        );
                      }
                      setIsBoardMenuOpen(false);
                    }}
                  >
                    <Download className="w-3.5 h-3.5 metrics-board-widget-menu-icon" />
                    <span className="metrics-board-widget-menu-copy">
                      <strong>{t("metrics.boardExport")}</strong>
                      <small>{t("metrics.boardExportDesc")}</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="metrics-board-widget-menu-item"
                    onClick={() => {
                      const input = document.createElement("input");
                      input.type = "file";
                      input.accept = ".json";
                      input.onchange = async () => {
                        const file = input.files?.[0];
                        if (!file) return;
                        const text = await file.text();
                        const board = deserializeBoard(text, connectionId, boards);
                        if (board) {
                          persistBoards([board, ...boards]);
                          setActiveBoardId(board.id);
                        }
                      };
                      input.click();
                      setIsBoardMenuOpen(false);
                    }}
                  >
                    <Upload className="w-3.5 h-3.5 metrics-board-widget-menu-icon" />
                    <span className="metrics-board-widget-menu-copy">
                      <strong>{t("metrics.boardImport")}</strong>
                      <small>{t("metrics.boardImportDesc")}</small>
                    </span>
                  </button>
                  <div className="metrics-board-widget-menu-divider" />
                  <button
                    type="button"
                    role="menuitem"
                    className="metrics-board-widget-menu-item"
                    onClick={() => {
                      setRefreshToken((v) => v + 1);
                      setIsBoardMenuOpen(false);
                    }}
                  >
                    <RefreshCw className="w-3.5 h-3.5 metrics-board-widget-menu-icon" />
                    <span className="metrics-board-widget-menu-copy">
                      <strong>{t("metrics.boardRefreshAll")}</strong>
                      <small>{t("metrics.boardRefreshAllDesc")}</small>
                    </span>
                  </button>
                </div>
              )}
            </div>

            {widgetLibrary.length > 0 && (
              <div className="metrics-board-widget-menu" ref={widgetMenuRef}>
                <button
                  type="button"
                  className="metrics-board-topbar-action"
                  onClick={() => setIsWidgetMenuOpen((value) => !value)}
                  disabled={!activeBoard}
                  aria-haspopup="menu"
                  aria-expanded={isWidgetMenuOpen}
                  title={
                    language === "vi" ? "Them widget moi vao bang" : "Add a new widget to the board"
                  }
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  <span>{language === "vi" ? "Them widget" : "Add widget"}</span>
                  <ChevronDown className="w-3 h-3 metrics-board-widget-menu-caret" />
                </button>

                {isWidgetMenuOpen && (
                  <div className="metrics-board-widget-menu-list" role="menu">
                    {widgetLibrary.map((item) => {
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.type}
                          type="button"
                          role="menuitem"
                          className="metrics-board-widget-menu-item"
                          onClick={() => {
                            addWidget(item.type);
                            setIsWidgetMenuOpen(false);
                          }}
                          disabled={!activeBoard}
                        >
                          <Icon className="w-3.5 h-3.5 metrics-board-widget-menu-icon" />
                          <span className="metrics-board-widget-menu-copy">
                            <strong>{item.label}</strong>
                            <small>{item.description}</small>
                          </span>
                        </button>
                      );
                    })}
                    <div className="metrics-board-widget-menu-divider" />
                    <div className="metrics-board-widget-menu-section">
                      {t("metrics.templates")}
                    </div>
                    {WIDGET_TEMPLATES.map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        role="menuitem"
                        className="metrics-board-widget-menu-item"
                        onClick={() => {
                          addWidget(tpl.type, undefined, {
                            title: t(tpl.titleKey),
                            query: tpl.query,
                            colSpan: tpl.colSpan,
                            rowSpan: tpl.rowSpan,
                          });
                          setIsWidgetMenuOpen(false);
                        }}
                        disabled={!activeBoard}
                      >
                        <LayoutTemplate className="w-3.5 h-3.5 metrics-board-widget-menu-icon" />
                        <span className="metrics-board-widget-menu-copy">
                          <strong>{t(tpl.titleKey)}</strong>
                          <small>{t(tpl.descriptionKey)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <MetricsBoardCanvas
          connectionId={connectionId}
          onOpenResult={openWidgetResult}
          onOpenQuery={openWidgetQuery}
          onFullscreen={(widget) => setFullscreenWidgetId(widget.id)}
          onDrillDown={drillDownWidget}
          onWidgetRefreshed={handleWidgetRefreshed}
          refreshToken={refreshToken}
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
          widgetContextMenu={widgetContextMenu}
          setWidgetContextMenu={setWidgetContextMenu}
          openWidgetContextMenu={openWidgetContextMenu}
          updateWidgetById={updateWidgetById}
          duplicateWidget={duplicateWidget}
          deleteWidgetWithUndo={deleteWidgetWithUndo}
          undoDelete={undoDelete}
          onUndoDelete={() => {
            if (undoDelete) restoreWidget(undoDelete.widget);
            setUndoDelete(null);
          }}
          onDismissUndo={() => setUndoDelete(null)}
          setEditingWidgetId={setEditingWidgetId}
          setActiveWidgetId={setActiveWidgetId}
        />
      </div>

      {fullscreenWidgetId ? (
        <div
          className="metrics-fullscreen-overlay"
          onClick={() => setFullscreenWidgetId(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setFullscreenWidgetId(null);
          }}
        >
          <div className="metrics-fullscreen-card" onClick={(event) => event.stopPropagation()}>
            {(() => {
              const widget = activeBoard?.widgets.find((w) => w.id === fullscreenWidgetId);
              if (!widget) return null;
              return (
                <MetricsWidgetCard
                  widget={widget}
                  connectionId={connectionId}
                  onOpenResult={openWidgetResult}
                  onOpenQuery={openWidgetQuery}
                  selected={false}
                  dragging={false}
                  resizing={false}
                  layoutStyle={{ width: "100%", height: "100%" }}
                  onSelect={() => undefined}
                  onDragStart={() => undefined}
                  onResizeStart={() => undefined}
                  onContextMenu={() => undefined}
                  onFullscreen={() => setFullscreenWidgetId(null)}
                  onDrillDown={drillDownWidget}
                  onWidgetRefreshed={handleWidgetRefreshed}
                  refreshToken={refreshToken}
                />
              );
            })()}
          </div>
        </div>
      ) : null}
    </div>
  );
}
