import {
  Database,
  Menu,
  Minus,
  Plus,
  Copy,
  Square,
  X,
  Settings2,
  PanelRightClose,
  ChevronRight,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { RefObject } from "react";
import type { ConnectionConfig } from "../types/database";
import { UI_FONT_SCALE_MAX, UI_FONT_SCALE_MIN, UI_FONT_SCALE_STEP } from "../utils/ui-scale";

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
  controlType?: "font-scale-slider";
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange?: (next: number) => void;
  onDecrease?: () => void;
  onIncrease?: () => void;
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
  windowMenuRef: RefObject<HTMLDivElement | null>;
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
              onClick={() => {
                onSetActiveWindowMenuSection(section.key);
                onSetActiveWindowMenuItemPath(null);
              }}
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
                  ) : item.controlType === "font-scale-slider" ? (
                    <div
                      key={`${section.key}-${item.key || item.label}-${index}`}
                      className="titlebar-window-menu-slider"
                      data-no-window-drag="true"
                      onMouseEnter={() => onSetActiveWindowMenuItemPath(null)}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                    >
                      <div className="titlebar-window-menu-slider-head">
                        <span className="titlebar-window-menu-slider-label">{item.label}</span>
                        <span className="titlebar-window-menu-slider-value">
                          {item.value ?? 100}%
                        </span>
                      </div>
                      <div className="titlebar-window-menu-slider-controls">
                        <button
                          type="button"
                          className="titlebar-window-menu-slider-btn"
                          title={t("menu.item.decreaseFontSize")}
                          aria-label={t("menu.item.decreaseFontSize")}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={() => item.onDecrease?.()}
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <input
                          type="range"
                          className="titlebar-window-menu-slider-input"
                          min={item.min ?? UI_FONT_SCALE_MIN}
                          max={item.max ?? UI_FONT_SCALE_MAX}
                          step={item.step ?? UI_FONT_SCALE_STEP}
                          value={item.value ?? 100}
                          aria-label={item.label}
                          style={{
                            background: `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${
                              (((item.value ?? 100) - (item.min ?? UI_FONT_SCALE_MIN)) /
                                Math.max(1, (item.max ?? UI_FONT_SCALE_MAX) - (item.min ?? UI_FONT_SCALE_MIN))) *
                              100
                            }%, rgba(255, 255, 255, 0.1) ${
                              (((item.value ?? 100) - (item.min ?? UI_FONT_SCALE_MIN)) /
                                Math.max(1, (item.max ?? UI_FONT_SCALE_MAX) - (item.min ?? UI_FONT_SCALE_MIN))) *
                              100
                            }%, rgba(255, 255, 255, 0.1) 100%)`,
                          }}
                          onMouseDown={(event) => {
                            event.stopPropagation();
                          }}
                          onChange={(event) => item.onValueChange?.(Number(event.target.value))}
                        />
                        <button
                          type="button"
                          className="titlebar-window-menu-slider-btn"
                          title={t("menu.item.increaseFontSize")}
                          aria-label={t("menu.item.increaseFontSize")}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={() => item.onIncrease?.()}
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
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
                        onClick={() => {
                          if (item.children) {
                            const path = `${section.key}:${item.key || index}`;
                            onSetActiveWindowMenuItemPath(
                              activeWindowMenuItemPath === path ? null : path,
                            );
                            return;
                          }

                          item.action?.();
                        }}
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
                                  data-no-window-drag="true"
                                  onMouseDown={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    if (!child.disabled) {
                                      child.action?.();
                                    }
                                  }}
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
  windowMenuRef,
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
        <div ref={windowMenuRef} className="titlebar-window-menu">
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
          <Database className="titlebar-brand-icon w-4 h-4" />
          <span className="titlebar-name">TableR</span>
        </div>

        <div className="titlebar-divider" />

        <div className="titlebar-context">
          <span className="titlebar-context-label">{t("common.workspace")}</span>
          {isConnected && activeConn ? (
            <div className="titlebar-badge" title={titlebarContextTitle}>
              <span
                className="titlebar-badge-dot"
                style={{ backgroundColor: activeConn.color || "var(--success)" }}
              />
              <span className="truncate">
                {titlebarContextLabel}
              </span>
            </div>
          ) : (
            <div className="titlebar-badge muted">
              <span className="titlebar-badge-dot" />
              <span className="truncate">{t("titlebar.noActiveConnection")}</span>
            </div>
          )}
        </div>

        <div className="titlebar-spacer" />
      </div>

      <div className="titlebar-actions" data-no-window-drag="true">
        <span className="popover-container" data-popover="AI Settings">
          <button
            onClick={onOpenAISettings}
            className="titlebar-icon-btn"
            title={t("titlebar.aiSettings")}
          >
            <Settings2 className="w-4 h-4" />
          </button>
        </span>

        <span className="popover-container" data-popover="Toggle Sidebar">
          <button
            onClick={onToggleSidebar}
            className="titlebar-icon-btn"
            title={t("titlebar.expandSidebar")}
          >
            <PanelRightClose className="w-4 h-4" />
          </button>
        </span>
      </div>

      {renderWindowControls()}
    </header>
  );
}
