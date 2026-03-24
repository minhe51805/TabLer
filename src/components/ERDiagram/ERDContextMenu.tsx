import { createPortal } from "react-dom";

const ERD_CONTEXT_MENU_WIDTH = 228;
const ERD_CONTEXT_MENU_MAX_HEIGHT = 420;

export interface ERDContextMenuState {
  x: number;
  y: number;
  tableName: string;
  schemaName?: string;
  columnName?: string;
}

export interface ERDContextMenuItem {
  key: string;
  label?: string;
  action?: () => void;
  divider?: boolean;
  danger?: boolean;
}

interface Props {
  contextMenu: ERDContextMenuState | null;
  items: ERDContextMenuItem[];
  onClose: () => void;
}

export function ERDContextMenu({ contextMenu, items, onClose }: Props) {
  if (!contextMenu) return null;

  const menuLeft = Math.min(contextMenu.x, window.innerWidth - ERD_CONTEXT_MENU_WIDTH - 16);
  const menuTop = Math.min(contextMenu.y, window.innerHeight - ERD_CONTEXT_MENU_MAX_HEIGHT);

  return createPortal(
    <div
      className="explorer-context-menu erd-context-menu"
      style={{ left: menuLeft, top: menuTop }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="erd-context-menu-header">
        <strong className="erd-context-menu-title">{contextMenu.columnName || contextMenu.tableName}</strong>
        <span className="erd-context-menu-meta">
          {contextMenu.columnName ? `${contextMenu.tableName}` : contextMenu.schemaName || "table"}
        </span>
      </div>

      {items.map((item) =>
        item.divider ? (
          <div key={item.key} className="explorer-context-menu-divider" />
        ) : (
          <button
            key={item.key}
            type="button"
            className={`explorer-context-menu-item ${item.danger ? "danger" : ""}`}
            onClick={() => {
              item.action?.();
              onClose();
            }}
          >
            <span>{item.label}</span>
          </button>
        )
      )}
    </div>,
    document.body
  );
}
