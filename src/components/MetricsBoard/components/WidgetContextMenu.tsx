import { ChevronRight, Copy, Pencil, Timer, Trash2 } from "lucide-react";
import { useI18n } from "../../../i18n";
import type { MetricsWidgetDefinition, MetricsWidgetType } from "../../../types";
import { getWidgetLibrary, getMetricsRefreshSelectOptions } from "../utils/query-builder";

interface WidgetContextMenuProps {
  menu: {
    widgetId: string;
    left: number;
    top: number;
    submenu: "type" | "refresh" | null;
  };
  widget: MetricsWidgetDefinition | null;
  onClose: () => void;
  onSubmenu: (submenu: "type" | "refresh" | null) => void;
  onEdit: (widgetId: string) => void;
  onDuplicate: (widgetId: string) => void;
  onChangeType: (widgetId: string, type: MetricsWidgetType) => void;
  onChangeRefresh: (widgetId: string, seconds: number) => void;
  onDelete: (widgetId: string) => void;
}

/** Right-click menu on a widget card: edit, duplicate, change type, refresh rate, delete. */
export function WidgetContextMenu({
  menu,
  widget,
  onClose: _onClose,
  onSubmenu,
  onEdit,
  onDuplicate,
  onChangeType,
  onChangeRefresh,
  onDelete,
}: WidgetContextMenuProps) {
  const { t } = useI18n();
  if (!widget) return null;

  return (
    <div
      className="metrics-widget-context-menu"
      style={{ left: `${menu.left}px`, top: `${menu.top}px` }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="metrics-board-context-item"
        onClick={() => onEdit(widget.id)}
      >
        <Pencil className="w-3.5 h-3.5" />
        <span>{t("metrics.widget.edit")}</span>
      </button>
      <button
        type="button"
        className="metrics-board-context-item"
        onClick={() => onDuplicate(widget.id)}
      >
        <Copy className="w-3.5 h-3.5" />
        <span>{t("metrics.widget.duplicate")}</span>
      </button>

      <div
        className="metrics-board-context-trigger"
        onMouseEnter={() => onSubmenu("type")}
        onMouseLeave={() => onSubmenu(null)}
      >
        <button type="button" className="metrics-board-context-button">
          <span>{t("metrics.editor.widgetType")}</span>
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        {menu.submenu === "type" ? (
          <div className="metrics-board-context-submenu">
            {getWidgetLibrary().map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.type}
                  type="button"
                  className={`metrics-board-context-item ${item.type === widget.type ? "active" : ""}`}
                  onClick={() => onChangeType(widget.id, item.type)}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div
        className="metrics-board-context-trigger"
        onMouseEnter={() => onSubmenu("refresh")}
        onMouseLeave={() => onSubmenu(null)}
      >
        <button type="button" className="metrics-board-context-button">
          <Timer className="w-3.5 h-3.5" />
          <span>{t("metrics.editor.refreshRate")}</span>
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        {menu.submenu === "refresh" ? (
          <div className="metrics-board-context-submenu">
            {getMetricsRefreshSelectOptions().map((option) => (
              <button
                key={option.value}
                type="button"
                className={`metrics-board-context-item ${option.value === widget.refresh_seconds ? "active" : ""}`}
                onClick={() => onChangeRefresh(widget.id, option.value)}
              >
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="metrics-board-context-separator" />
      <button
        type="button"
        className="metrics-board-context-item danger"
        onClick={() => onDelete(widget.id)}
      >
        <Trash2 className="w-3.5 h-3.5" />
        <span>{t("metrics.widget.delete")}</span>
      </button>
    </div>
  );
}
