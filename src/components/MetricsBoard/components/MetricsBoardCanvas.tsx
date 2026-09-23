import { ChevronRight } from "lucide-react";
import type { CSSProperties } from "react";
import type {
  MetricsBoardDefinition,
  MetricsWidgetDefinition,
  MetricsWidgetType,
  QueryResult,
} from "../../../types";
import { useI18n } from "../../../i18n";
import { getWidgetLibrary } from "../utils/query-builder";
import { MetricsWidgetCard } from "./MetricsWidget";
import { MetricsEditor } from "./MetricsEditor";
import { WidgetContextMenu } from "./WidgetContextMenu";
import "../../../styles/metrics-tools.css";

interface CanvasContextMenuState {
  left: number;
  top: number;
  grid_x: number;
  grid_y: number;
  submenuOpen: boolean;
}

interface DragState {
  widgetId: string;
  startClientX: number;
  startClientY: number;
  originGridX: number;
  originGridY: number;
  previewGridX: number;
  previewGridY: number;
}

interface ResizeState {
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
}

interface WidgetEditorLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  side: "left" | "right";
}

interface Props {
  connectionId: string;
  onOpenResult: (widget: MetricsWidgetDefinition, result: QueryResult) => void;
  onOpenQuery: (widget: MetricsWidgetDefinition) => void;
  onFullscreen: (widget: MetricsWidgetDefinition) => void;
  onDrillDown: (widget: MetricsWidgetDefinition, label: string, result: QueryResult) => void;
  refreshToken: number;
  onWidgetRefreshed: () => void;
  activeBoard: MetricsBoardDefinition | null;
  activeWidgetId: string | null;
  editingWidget: MetricsWidgetDefinition | null;
  widgetQueryDraft?: string;
  setWidgetQueryDraft: (value: string) => void;
  canvasContextMenu: CanvasContextMenuState | null;
  dragState: DragState | null;
  resizeState: ResizeState | null;
  surfaceWidth: number;
  surfaceContentHeight: number;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  boardZoom?: number;
  onZoomChange?: (zoom: number) => void;
  getWidgetLayoutStyle: (widget: MetricsWidgetDefinition) => CSSProperties;
  handleWidgetSelection: (widgetId: string) => void;
  handleWidgetDragStart: (
    widget: MetricsWidgetDefinition,
    clientX: number,
    clientY: number,
  ) => void;
  handleWidgetResizeStart: (
    widget: MetricsWidgetDefinition,
    clientX: number,
    clientY: number,
  ) => void;
  openCanvasContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
  addWidget: (
    type: MetricsWidgetType,
    preferredPosition?: { grid_x: number; grid_y: number },
  ) => void;
  updateSelectedWidget: (updates: Partial<MetricsWidgetDefinition>) => void;
  clearWidgetSelection: () => void;
  deleteSelectedWidget: () => void;
  widgetEditorLayout: WidgetEditorLayout | null;
  setCanvasContextMenu: (
    state:
      | CanvasContextMenuState
      | null
      | ((prev: CanvasContextMenuState | null) => CanvasContextMenuState | null),
  ) => void;
  widgetContextMenu: {
    widgetId: string;
    left: number;
    top: number;
    submenu: "type" | "refresh" | null;
  } | null;
  setWidgetContextMenu: (
    state: {
      widgetId: string;
      left: number;
      top: number;
      submenu: "type" | "refresh" | null;
    } | null,
  ) => void;
  openWidgetContextMenu: (widgetId: string, clientX: number, clientY: number) => void;
  updateWidgetById: (widgetId: string, updates: Partial<MetricsWidgetDefinition>) => void;
  duplicateWidget: (widgetId: string) => void;
  deleteWidgetWithUndo: (widgetId: string) => void;
  undoDelete: { widget: MetricsWidgetDefinition; expiresAt: number } | null;
  onUndoDelete: () => void;
  onDismissUndo: () => void;
  setEditingWidgetId: (id: string | null) => void;
  setActiveWidgetId: (id: string | null) => void;
}

export function MetricsBoardCanvas({
  connectionId,
  onOpenResult,
  onOpenQuery,
  onFullscreen,
  onDrillDown,
  refreshToken,
  onWidgetRefreshed,
  activeBoard,
  activeWidgetId,
  editingWidget,
  widgetQueryDraft: _widgetQueryDraft,
  setWidgetQueryDraft,
  canvasContextMenu,
  dragState,
  resizeState,
  surfaceWidth,
  boardZoom,
  onZoomChange,
  surfaceContentHeight,
  canvasRef,
  getWidgetLayoutStyle,
  handleWidgetSelection,
  handleWidgetDragStart,
  handleWidgetResizeStart,
  openCanvasContextMenu,
  addWidget,
  updateSelectedWidget,
  clearWidgetSelection,
  deleteSelectedWidget,
  widgetEditorLayout,
  setCanvasContextMenu,
  widgetContextMenu,
  setWidgetContextMenu,
  openWidgetContextMenu,
  updateWidgetById,
  duplicateWidget,
  deleteWidgetWithUndo,
  undoDelete,
  onUndoDelete,
  onDismissUndo,
  setEditingWidgetId,
  setActiveWidgetId,
}: Props) {
  const { t } = useI18n();

  return (
    <div
      className="metrics-board-canvas"
      ref={canvasRef}
      onWheel={(e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        onZoomChange?.(Math.min(2, Math.max(0.5, (boardZoom ?? 1) + delta)));
      }}
    >
      <div
        className={`metrics-board-surface ${dragState ? "dragging" : ""}`}
        style={{
          width: `${surfaceWidth}px`,
          transform: `scale(${boardZoom ?? 1})`,
          transformOrigin: "top left",
          minHeight: `${surfaceContentHeight}px`,
        }}
        onContextMenu={openCanvasContextMenu}
      >
        <div className="metrics-board-grid">
          {activeBoard?.widgets.map((widget) => (
            <MetricsWidgetCard
              key={widget.id}
              widget={widget}
              connectionId={connectionId}
              onOpenResult={onOpenResult}
              onOpenQuery={onOpenQuery}
              selected={activeWidgetId === widget.id}
              dragging={dragState?.widgetId === widget.id}
              resizing={resizeState?.widgetId === widget.id}
              layoutStyle={getWidgetLayoutStyle(widget)}
              onSelect={() => handleWidgetSelection(widget.id)}
              onDragStart={(clientX, clientY) => handleWidgetDragStart(widget, clientX, clientY)}
              onResizeStart={(clientX, clientY) =>
                handleWidgetResizeStart(widget, clientX, clientY)
              }
              onContextMenu={openWidgetContextMenu}
              onFullscreen={onFullscreen}
              onDrillDown={onDrillDown}
              refreshToken={refreshToken}
              onWidgetRefreshed={onWidgetRefreshed}
            />
          ))}

          {widgetContextMenu ? (
            <WidgetContextMenu
              menu={widgetContextMenu}
              widget={activeBoard?.widgets.find((w) => w.id === widgetContextMenu.widgetId) ?? null}
              onClose={() => setWidgetContextMenu(null)}
              onSubmenu={(submenu) =>
                setWidgetContextMenu(widgetContextMenu ? { ...widgetContextMenu, submenu } : null)
              }
              onEdit={(id) => {
                setActiveWidgetId(id);
                setEditingWidgetId(id);
                setWidgetContextMenu(null);
              }}
              onDuplicate={(id) => {
                duplicateWidget(id);
                setWidgetContextMenu(null);
              }}
              onChangeType={(id, type) => {
                updateWidgetById(id, { type });
                setWidgetContextMenu(null);
              }}
              onChangeRefresh={(id, seconds) => {
                updateWidgetById(id, { refresh_seconds: seconds });
                setWidgetContextMenu(null);
              }}
              onDelete={(id) => {
                deleteWidgetWithUndo(id);
                setWidgetContextMenu(null);
              }}
            />
          ) : null}

          {undoDelete ? (
            <div className="metrics-undo-toast" role="status">
              <span>{t("metrics.widget.deleted")}</span>
              <button type="button" onClick={onUndoDelete}>
                {t("metrics.widget.undo")}
              </button>
              <button type="button" aria-label={t("common.close")} onClick={onDismissUndo}>
                ×
              </button>
            </div>
          ) : null}
        </div>

        {canvasContextMenu ? (
          <div
            className="metrics-board-context-menu-shell"
            style={{
              left: `${canvasContextMenu.left}px`,
              top: `${canvasContextMenu.top}px`,
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div
              className="metrics-board-context-trigger"
              onMouseEnter={() =>
                setCanvasContextMenu((current) =>
                  current ? { ...current, submenuOpen: true } : current,
                )
              }
              onMouseLeave={() =>
                setCanvasContextMenu((current) =>
                  current ? { ...current, submenuOpen: false } : current,
                )
              }
            >
              <button
                type="button"
                className="metrics-board-context-button"
                onClick={() =>
                  setCanvasContextMenu((current) =>
                    current ? { ...current, submenuOpen: !current.submenuOpen } : current,
                  )
                }
              >
                <span>{t("metrics.context.add")}</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>

              {canvasContextMenu.submenuOpen ? (
                <div className="metrics-board-context-submenu">
                  {getWidgetLibrary().map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.type}
                        type="button"
                        className="metrics-board-context-item"
                        onClick={() =>
                          addWidget(item.type, {
                            grid_x: canvasContextMenu.grid_x,
                            grid_y: canvasContextMenu.grid_y,
                          })
                        }
                      >
                        <Icon className="w-3.5 h-3.5" />
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {editingWidget && widgetEditorLayout ? (
          <MetricsEditor
            connectionId={connectionId}
            editingWidget={editingWidget}
            widgetEditorLayout={widgetEditorLayout}
            onQueryDraftChange={setWidgetQueryDraft}
            onUpdateWidget={updateSelectedWidget}
            onClearSelection={clearWidgetSelection}
            onDelete={deleteSelectedWidget}
          />
        ) : null}
      </div>
    </div>
  );
}
