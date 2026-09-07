import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import type { TableInfo } from "../../../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXPLORER_CONTEXT_MENU_WIDTH = 220;
const EXPLORER_CONTEXT_SUBMENU_WIDTH = 228;
const EXPLORER_CONTEXT_MENU_MAX_HEIGHT = 440;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExplorerContextMenuItem {
  key: string;
  label?: string;
  action?: () => void;
  children?: ExplorerContextMenuItem[];
  divider?: boolean;
  danger?: boolean;
}

export interface ContextMenuState {
  table: Pick<TableInfo, "name" | "schema" | "row_count">;
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ContextMenuProps {
  tableContextMenu: ContextMenuState | null;
  tableContextMenuItems: ExplorerContextMenuItem[];
  activeContextSubmenuKey: string | null;
  onClose: () => void;
  onSubmenuChange: (key: string | null) => void;
}

export function ContextMenu({
  tableContextMenu,
  tableContextMenuItems,
  activeContextSubmenuKey,
  onClose,
  onSubmenuChange,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [activeContextSubmenu, setActiveContextSubmenu] = useState<ExplorerContextMenuItem[] | null>(null);
  /** Vertical offset of the hovered submenu trigger inside the menu, so the
   *  flyout lines up with the item ("Import ▸") instead of the menu top. */
  const [submenuOffsetTop, setSubmenuOffsetTop] = useState(28);

  useEffect(() => {
    const found = tableContextMenuItems.find(
      (item) => item.key === activeContextSubmenuKey && item.children
    );
    setActiveContextSubmenu(found?.children ?? null);
  }, [activeContextSubmenuKey, tableContextMenuItems]);

  if (!tableContextMenu) return null;

  const menuLeft = Math.min(
    tableContextMenu.x,
    window.innerWidth - EXPLORER_CONTEXT_MENU_WIDTH - EXPLORER_CONTEXT_SUBMENU_WIDTH - 24
  );
  const menuTop = Math.min(tableContextMenu.y, window.innerHeight - EXPLORER_CONTEXT_MENU_MAX_HEIGHT);
  const submenuLeft =
    menuLeft + EXPLORER_CONTEXT_MENU_WIDTH + 8 + EXPLORER_CONTEXT_SUBMENU_WIDTH <= window.innerWidth - 12
      ? menuLeft + EXPLORER_CONTEXT_MENU_WIDTH + 8
      : menuLeft - EXPLORER_CONTEXT_SUBMENU_WIDTH - 8;

  return createPortal(
    <>
      <div
        ref={menuRef}
        className="explorer-context-menu"
        style={{ left: menuLeft, top: menuTop }}
        onContextMenu={(event) => event.preventDefault()}
      >
        {tableContextMenuItems.map((item) =>
          item.divider ? (
            <div key={item.key} className="explorer-context-menu-divider" />
          ) : (
            <button
              key={item.key}
              type="button"
              className={`explorer-context-menu-item ${item.danger ? "danger" : ""} ${
                activeContextSubmenuKey === item.key ? "active" : ""
              }`}
              onMouseEnter={(event) => {
                onSubmenuChange(item.children ? item.key : null);
                if (item.children) {
                  const trigger = event.currentTarget.getBoundingClientRect();
                  const host = menuRef.current?.getBoundingClientRect();
                  const offset = host ? trigger.top - host.top : 28;
                  setSubmenuOffsetTop(Math.max(0, offset));
                }
              }}
              onClick={() => {
                if (item.children) {
                  onSubmenuChange(item.key);
                  return;
                }
                item.action?.();
                onClose();
              }}
            >
              <span>{item.label}</span>
              {item.children ? <ChevronRight className="w-3.5 h-3.5" /> : null}
            </button>
          )
        )}
      </div>

      {activeContextSubmenu && (
        <div
          ref={submenuRef}
          className="explorer-context-menu explorer-context-menu-submenu"
          style={{ left: submenuLeft, top: menuTop + submenuOffsetTop }}
          onContextMenu={(event) => event.preventDefault()}
          onMouseLeave={() => onSubmenuChange(null)}
        >
          {activeContextSubmenu.map((item) => (
            <button
              key={item.key}
              type="button"
              className="explorer-context-menu-item"
              onClick={() => {
                item.action?.();
                onClose();
              }}
            >
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </>,
    document.body
  );
}
