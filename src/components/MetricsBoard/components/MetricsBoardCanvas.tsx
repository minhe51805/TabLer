import { ChevronRight } from "lucide-react";
import type { CSSProperties } from "react";
import type { MetricsBoardDefinition, MetricsWidgetDefinition, MetricsWidgetType } from "../../../types";
import { useI18n } from "../../../i18n";
import { getWidgetLibrary } from "../utils/query-builder";
import { MetricsWidgetCard } from "./MetricsWidget";
import { MetricsEditor } from "./MetricsEditor";

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
  getWidgetLayoutStyle: (widget: MetricsWidgetDefinition) => CSSProperties;
  handleWidgetSelection: (widgetId: string) => void;
  handleWidgetDragStart: (widget: MetricsWidgetDefinition, clientX: number, clientY: number) => void;
  handleWidgetResizeStart: (widget: MetricsWidgetDefinition, clientX: number, clientY: number) => void;
  openCanvasContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
  addWidget: (type: MetricsWidgetType, preferredPosition?: { grid_x: number; grid_y: number }) => void;
  updateSelectedWidget: (updates: Partial<MetricsWidgetDefinition>) => void;
  clearWidgetSelection: () => void;
  deleteSelectedWidget: () => void;
  widgetEditorLayout: WidgetEditorLayout | null;
  setCanvasContextMenu: (state: CanvasContextMenuState | null | ((prev: CanvasContextMenuState | null) => CanvasContextMenuState | null)) => void;
}

export function MetricsBoardCanvas({
  connectionId,
  activeBoard,
  activeWidgetId,
  editingWidget,
  widgetQueryDraft: _widgetQueryDraft,
  setWidgetQueryDraft,
  canvasContextMenu,
  dragState,
  resizeState,
  surfaceWidth,
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
}: Props) {
  const { t } = useI18n();

  return (
    <div className="metrics-board-canvas" ref={canvasRef}>
      <div
        className={`metrics-board-surface ${dragState ? "dragging" : ""}`}
        style={{ width: `${surfaceWidth}px`, minHeight: `${surfaceContentHeight}px` }}
        onContextMenu={openCanvasContextMenu}
      >
        <div className="metrics-board-grid">
          {activeBoard?.widgets.map((widget) => (
            <MetricsWidgetCard
              key={widget.id}
              widget={widget}
              connectionId={connectionId}
              selected={activeWidgetId === widget.id}
              dragging={dragState?.widgetId === widget.id}
              resizing={resizeState?.widgetId === widget.id}
              layoutStyle={getWidgetLayoutStyle(widget)}
              onSelect={() => handleWidgetSelection(widget.id)}
              onDragStart={(clientX, clientY) => handleWidgetDragStart(widget, clientX, clientY)}
              onResizeStart={(clientX, clientY) => handleWidgetResizeStart(widget, clientX, clientY)}
            />
          ))}
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
