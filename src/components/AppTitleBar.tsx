import {
  Database,
  Menu,
  Minus,
  Copy,
  Square,
  X,
  Settings2,
  PanelRightClose,
  ChevronRight,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ConnectionConfig } from "../types/database";

type WindowMenuSectionKey =
  | "file"
  | "edit"
  | "view"
  | "tools"
  | "connection"
  | "plugins"
  | "navigate"
  | "language"
  | "help";

interface WindowMenuItem {
  key?: string;
  label?: string;
  action?: () => void;
  disabled?: boolean;
  divider?: boolean;
  selected?: boolean;
  shortcut?: string;
  children?: WindowMenuItem[];
}

interface AppTitleBarProps {
  titlebarContextTitle: string;
  titlebarContextLabel: string;
  isConnected: boolean;
  activeConn: ConnectionConfig | undefined;
  isWindowMaximized: boolean;
  isWindowFocused: boolean;
  isWindowMenuOpen: boolean;
  activeWindowMenuSection: WindowMenuSectionKey | null;
  activeWindowMenuItemPath: string | null;
  windowMenuSections: { key: WindowMenuSectionKey; label: string; items: WindowMenuItem[] }[];
  onToggleSidebar: () => void;
  onOpenAISettings: () => void;
  onToggleMaximizeWindow: () => void;
  onMinimizeWindow: () => void;
  onCloseWindow: () => void;
  onToggleWindowMenu: (event?: React.MouseEvent<HTMLElement>) => void;
  onSetActiveWindowMenuSection: (section: WindowMenuSectionKey | null) => void;
  onSetActiveWindowMenuItemPath: (path: string | null) => void;
  isDesktopWindow: boolean;
  t: (key: import("../i18n").TranslationKey, params?: Record<string, string | number>) => string;
}

function renderWindowMenuPopover(
  windowMenuSections: { key: WindowMenuSectionKey; label: string; items: WindowMenuItem[] }[],
  isWindowMenuOpen: boolean,
  activeWindowMenuSection: WindowMenuSectionKey | null,
  activeWindowMenuItemPath: string | null,
  onSetActiveWindowMenuSection: (section: WindowMenuSectionKey | null) => void,
  onSetActiveWindowMenuItemPath: (path: string | null) => void,
  t: (key: import("../i18n").TranslationKey, params?: Record<string, string | number>) => string,
) {
  if (!isWindowMenuOpen) return null;

  return (
    <div className="titlebar-window-menu-popover">
      <div className="titlebar-window-menu-sections">
        {windowMenuSections.map((section) => (
          <div
            key={section.key}
            className={`titlebar-window-menu-section-node ${
              activeWindowMenuSection === section.key ? "active" : ""
            }`}
            onMouseEnter={() => {
              onSetActiveWindowMenuSection(section.key);
              onSetActiveWindowMenuItemPath(null);
            }}
            onFocus={() => {
              onSetActiveWindowMenuSection(section.key);
              onSetActiveWindowMenuItemPath(null);
            }}
          >
            <button
              type="button"
              className={`titlebar-window-menu-section-item ${
                activeWindowMenuSection === section.key ? "active" : ""
              }`}
            >
              <span>{section.label}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>

            {activeWindowMenuSection === section.key && (
              <div className="titlebar-window-submenu">
                <div className="titlebar-window-submenu-head">
                  <span className="titlebar-window-submenu-kicker">{t("titlebar.menu")}</span>
                  <span className="titlebar-window-submenu-title">{section.label}</span>
                </div>

                {section.items.map((item, index) =>
                  item.divider ? (
                    <div
                      key={`${section.key}-divider-${index}`}
                      className="titlebar-window-menu-divider"
                    />
                  ) : (
                    <div
                      key={`${section.key}-${item.key || item.label}-${index}`}
                      className="titlebar-window-menu-item-node"
                      onMouseEnter={() =>
                        onSetActiveWindowMenuItemPath(
                          item.children ? `${section.key}:${item.key || index}` : null,
                        )
                      }
                      onFocus={() =>
                        onSetActiveWindowMenuItemPath(
                          item.children ? `${section.key}:${item.key || index}` : null,
                        )
                      }
                    >
                      <button
                        type="button"
                        className={`titlebar-window-menu-item ${item.selected ? "selected" : ""} ${
                          item.children ? "has-children" : ""
                        }`}
                        onClick={item.children ? undefined : item.action}
                        disabled={item.disabled}
                      >
                        <span>{item.label}</span>
                        <span className="titlebar-window-menu-item-meta">
                          {item.shortcut ? (
                            <span className="titlebar-window-menu-shortcut">{item.shortcut}</span>
                          ) : null}
                          {item.children ? <ChevronRight className="w-3.5 h-3.5" /> : null}
                        </span>
                      </button>

                      {item.children &&
                        activeWindowMenuItemPath === `${section.key}:${item.key || index}` && (
                          <div className="titlebar-window-submenu titlebar-window-submenu-nested">
                            {item.children.map((child, childIndex) =>
                              child.divider ? (
                                <div
                                  key={`${section.key}-${item.key}-divider-${childIndex}`}
                                  className="titlebar-window-menu-divider"
                                />
                              ) : (
                                <button
                                  key={`${section.key}-${item.key}-${child.key || child.label}-${childIndex}`}
                                  type="button"
                                  className={`titlebar-window-menu-item ${
                                    child.selected ? "selected" : ""
                                  }`}
                                  onClick={child.action}
                                  disabled={child.disabled}
                                >
                                  <span>{child.label}</span>
                                  {child.shortcut ? (
                                    <span className="titlebar-window-menu-shortcut">
                                      {child.shortcut}
                                    </span>
                                  ) : null}
                                </button>
                              ),
                            )}
                          </div>
                        )}
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function AppTitleBar({
  titlebarContextTitle,
  titlebarContextLabel,
  isConnected,
  activeConn,
  isWindowMaximized,
  isWindowFocused,
  isWindowMenuOpen,
  activeWindowMenuSection,
  activeWindowMenuItemPath,
  windowMenuSections,
  onToggleSidebar,
  onOpenAISettings,
  onToggleMaximizeWindow,
  onMinimizeWindow,
  onCloseWindow,
  onToggleWindowMenu,
  onSetActiveWindowMenuSection,
  onSetActiveWindowMenuItemPath,
  isDesktopWindow,
  t,
}: AppTitleBarProps) {
  const renderWindowControls = (
    className?: string,
    options?: { lockSize?: boolean },
  ) => {
    if (!isDesktopWindow) return null;

    return (
      <div
        className={`titlebar-window-controls ${className ?? ""}`.trim()}
        data-no-window-drag="true"
      >
        <div className="titlebar-window-menu">
          <button
            type="button"
            onClick={onToggleWindowMenu}
            className={`titlebar-window-btn ${isWindowMenuOpen ? "active" : ""}`}
            title={t("titlebar.menu")}
            aria-label={t("titlebar.openAppMenu")}
          >
            <Menu className="w-4 h-4" />
          </button>

          {renderWindowMenuPopover(
            windowMenuSections,
            isWindowMenuOpen,
            activeWindowMenuSection,
            activeWindowMenuItemPath,
            onSetActiveWindowMenuSection,
            onSetActiveWindowMenuItemPath,
            t,
          )}
        </div>

        <button
          type="button"
          onClick={onMinimizeWindow}
          className="titlebar-window-btn"
          title={t("titlebar.minimize")}
          aria-label={t("titlebar.minimize")}
        >
          <Minus className="w-4 h-4" />
        </button>
        {!options?.lockSize ? (
          <button
            type="button"
            onClick={onToggleMaximizeWindow}
            className="titlebar-window-btn"
            title={isWindowMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
            aria-label={isWindowMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
          >
            {isWindowMaximized ? (
              <Copy className="w-3.5 h-3.5" />
            ) : (
              <Square className="w-3.5 h-3.5" />
            )}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onCloseWindow}
          className="titlebar-window-btn danger"
          title={t("titlebar.close")}
          aria-label={t("titlebar.close")}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  };

  return (
    <header
      className={`titlebar ${isWindowFocused ? "" : "inactive"}`}
      onMouseDown={(e) => {
        if (!isDesktopWindow) return;
        const target = e.target as HTMLElement | null;
        if (
          target?.closest(
            "button, input, textarea, select, option, a, [role='button'], [contenteditable='true'], [data-no-window-drag='true']",
          )
        ) {
          return;
        }
        void (async () => {
          try {
            await getCurrentWindow().startDragging();
          } catch (windowError) {
            console.error("Failed to start dragging window", windowError);
          }
        })();
      }}
    >
      <div
        className="titlebar-drag-strip"
        onDoubleClick={onToggleMaximizeWindow}
      >
        <div className="titlebar-brand">
          <Database className="w-4 h-4 text-[var(--accent)]" />
          <span className="titlebar-name">TableR</span>
        </div>

        <div className="titlebar-divider" />

        <div className="titlebar-context">
          <span className="titlebar-context-label">{t("common.workspace")}</span>
          {isConnected && activeConn ? (
            <div className="titlebar-badge" title={titlebarContextTitle}>
              <span
                className="w-2 h-2 rounded-sm shrink-0"
                style={{ backgroundColor: activeConn.color || "var(--success)" }}
              />
              <span className="truncate">
                {titlebarContextLabel}
              </span>
            </div>
          ) : (
            <div className="titlebar-badge muted">
              <span className="w-2 h-2 rounded-sm shrink-0 bg-white/25" />
              <span className="truncate">{t("titlebar.noActiveConnection")}</span>
            </div>
          )}
        </div>

        <div className="titlebar-spacer" />
      </div>

      <div className="titlebar-actions" data-no-window-drag="true">
        <button
          onClick={onOpenAISettings}
          className="titlebar-icon-btn"
          title={t("titlebar.aiSettings")}
        >
          <Settings2 className="w-4 h-4" />
        </button>

        <button
          onClick={onToggleSidebar}
          className="titlebar-icon-btn"
          title={t("titlebar.expandSidebar")}
        >
          <PanelRightClose className={`w-4 h-4`} />
        </button>
      </div>

      {renderWindowControls()}
    </header>
  );
}
