import React, { useRef, useState, useEffect, useCallback } from "react";
import { Menu, ChevronRight, Minus, Check, Plus } from "lucide-react";
// @ts-ignore
import { useTranslation } from "react-i18next";
import { UI_FONT_SCALE_MAX, UI_FONT_SCALE_MIN, UI_FONT_SCALE_STEP } from "../../utils/ui-scale";

export type WindowMenuSectionKey =
  | "file"
  | "edit"
  | "view"
  | "tools"
  | "connection"
  | "plugins"
  | "navigate"
  | "language"
  | "help";

export interface WindowMenuItem {
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

const DEFAULT_WINDOW_MENU_SECTION: WindowMenuSectionKey = "file";

export interface AppWindowMenuActions {
  onNewConnection: () => void;
  onNewQuery: () => void;
  onOpenDatabaseFile: () => void;
  onImportSqlFile: () => void;
  onImportSqlIntoCurrentDatabase: () => void;
  onExportDatabase: () => void;
  onShowConnectionExporter: () => void;
  onShowConnectionImporter: () => void;
  onToggleSQLFavorites: () => void;
  onOpenMetricsBoard: () => void;
  onCloseWindow: () => void;
  onOpenAISettings: () => void;
  onOpenAISlidePanel: () => void;
  onShowAboutModal: () => void;
  onShowKeyboardShortcutsModal: () => void;
  onRefreshWorkspace: () => void;
  onFocusExplorerSearch: () => void;
  onSearchInDatabase: () => void;
  onOpenProcessList: () => void;
  onOpenUserManagement: () => void;
  onToggleQueryHistory: () => void;
  onOpenPluginManager: () => void;
  onToggleBottomSidebar: () => void;
  onToggleSidebar: () => void;
  onToggleRightSidebar: () => void;
  onToggleTerminalPanel: () => void;
  onToggleQueryResultsPane: () => void;
  onShowDatabaseWorkspace: () => void;
  onActivateTheme: (themeId: string) => void;
  onChangeLanguage: (lang: string) => void;
  onSetUiFontScale: (next: number) => void;
  onIncreaseFontSizeInline: () => void;
  onDecreaseFontSizeInline: () => void;
}

export interface AppWindowMenuProps {
  isConnected: boolean;
  supportsSqlFileActions: boolean;
  hasConnections: boolean;
  uiFontScale: number;
  currentLanguage: string;
  themeMenuOptions: { id: string; name: string }[];
  actions: AppWindowMenuActions;
  toggleVimMode?: () => void;
  vimModeEnabled?: boolean;
  activeTab?: { type: string };
  toggleTerminalLabel?: string;
  themeMenuLabel?: string;
  activeTheme?: { id: string };
  currentTheme?: { name: string };
}

export function AppWindowMenu({
  isConnected,
  supportsSqlFileActions,
  hasConnections,
  uiFontScale,
  currentLanguage: _currentLanguage,
  themeMenuOptions,
  actions,
  toggleVimMode,
  vimModeEnabled,
  activeTab,
  toggleTerminalLabel,
  themeMenuLabel,
  activeTheme = { id: "" }
}: AppWindowMenuProps) {
  const { t } = useTranslation();
  const [isWindowMenuOpen, setIsWindowMenuOpen] = useState(false);
  const [activeWindowMenuSection, setActiveWindowMenuSection] = useState<WindowMenuSectionKey | null>(null);
  const [activeWindowMenuItemPath, setActiveWindowMenuItemPath] = useState<string | null>(null);
  const windowMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isWindowMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && windowMenuRef.current?.contains(target)) {
        return;
      }
      setIsWindowMenuOpen(false);
      setActiveWindowMenuItemPath(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsWindowMenuOpen(false);
        setActiveWindowMenuItemPath(null);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isWindowMenuOpen]);

  const handleToggleWindowMenu = useCallback((_event?: React.MouseEvent<HTMLElement>) => {
    setIsWindowMenuOpen((current) => {
      if (!current) {
        setActiveWindowMenuSection(DEFAULT_WINDOW_MENU_SECTION);
        setActiveWindowMenuItemPath(null);
      }
      return !current;
    });
  }, []);

  const wrapAction = (fn: () => void) => () => {
    setIsWindowMenuOpen(false);
    fn();
  };

    const windowMenuSections: { key: WindowMenuSectionKey; label: string; items: WindowMenuItem[] }[] = [
    {
      key: "file",
      label: t("menu.section.file"),
      items: [
        { label: t("menu.item.newConnection"), action: wrapAction(actions.onNewConnection) },
        { label: t("menu.item.newQuery"), action: wrapAction(actions.onNewQuery), disabled: !isConnected },
        { label: t("menu.item.openDatabaseFile"), action: wrapAction(actions.onOpenDatabaseFile), shortcut: "Ctrl+Shift+O" },
        { label: t("menu.item.openSqlFile"), action: wrapAction(actions.onImportSqlFile), shortcut: "Ctrl+O", disabled: !supportsSqlFileActions },
        { label: t("menu.item.importSqlIntoDatabase"), action: wrapAction(actions.onImportSqlIntoCurrentDatabase), disabled: !supportsSqlFileActions },
        { label: t("menu.item.exportDatabase"), action: wrapAction(actions.onExportDatabase), disabled: !isConnected },
        { divider: true },
        { label: t("menu.item.exportConnections"), action: wrapAction(actions.onShowConnectionExporter), disabled: !hasConnections },
        { label: t("menu.item.importConnections"), action: wrapAction(actions.onShowConnectionImporter) },
        { divider: true },
        { label: t("menu.item.openSqlFavorites"), action: wrapAction(actions.onToggleSQLFavorites), shortcut: "Ctrl+Shift+S" },
        { divider: true },
        { label: t("menu.item.openMetrics"), action: wrapAction(actions.onOpenMetricsBoard), disabled: !isConnected },
        { divider: true },
        { label: t("menu.item.exit"), action: wrapAction(actions.onCloseWindow) },
      ],
    },
    {
      key: "edit",
      label: t("menu.section.edit"),
      items: [
        { label: t("menu.item.aiSettings"), action: wrapAction(actions.onOpenAISettings) },
        { label: t("menu.item.askAI"), action: wrapAction(actions.onOpenAISlidePanel), disabled: !isConnected },
      ],
    },
    {
      key: "view",
      label: t("menu.section.view"),
      items: [
        {
          key: "font-size-slider",
          label: t("menu.item.fontSize"),
          controlType: "font-scale-slider",
          value: uiFontScale,
          min: UI_FONT_SCALE_MIN,
          max: UI_FONT_SCALE_MAX,
          step: UI_FONT_SCALE_STEP,
          onValueChange: actions.onSetUiFontScale,
          onDecrease: actions.onDecreaseFontSizeInline,
          onIncrease: actions.onIncreaseFontSizeInline,
        },
        { divider: true },
        {
          key: "toggle-vim-mode",
          label: t("menu.item.toggleVimMode"),
          action: toggleVimMode,
          selected: vimModeEnabled,
          shortcut: "Ctrl Shift V",
        },
        { divider: true },
        {
          key: "toggle-sidebars",
          label: t("menu.item.toggleSidebars"),
          children: [
            {
              key: "toggle-left-sidebar",
              label: t("menu.item.toggleLeftSidebar"),
              action: wrapAction(actions.onToggleSidebar),
              shortcut: "Ctrl 0",
            },
            {
              key: "toggle-right-sidebar",
              label: t("menu.item.toggleRightSidebar"),
              action: wrapAction(actions.onToggleRightSidebar),
              shortcut: "Ctrl Space",
            },
            {
              key: "toggle-bottom-sidebar",
              label: t("menu.item.toggleBottomSidebar"),
              action: wrapAction(actions.onToggleBottomSidebar),
              shortcut: "Ctrl Shift C",
            },
            {
              key: "toggle-terminal-panel",
              label: toggleTerminalLabel,
              action: wrapAction(actions.onToggleTerminalPanel),
              shortcut: "Ctrl `",
            },
            {
              key: "toggle-query-results-pane",
              label: t("menu.item.toggleQueryResultsPane"),
              action: wrapAction(actions.onToggleQueryResultsPane),
              disabled: activeTab?.type !== "query",
              shortcut: "Ctrl Shift `",
            },
          ],
        },
        { divider: true },
        {
          key: "theme",
          label: themeMenuLabel,
          children: themeMenuOptions.map((option) => ({
            key: option.id,
            label: option.name,
            action: () => actions.onActivateTheme(option.id),
            selected: activeTheme.id === option.id,
          })),
        },
      ],
    },
  ];

  return (
    <div ref={windowMenuRef} className="titlebar-window-menu">
      <button
        type="button"
        onClick={handleToggleWindowMenu}
        className={`titlebar-window-btn ${isWindowMenuOpen ? "active" : ""}`}
        title={t("titlebar.menu")}
        aria-label={t("titlebar.openAppMenu")}
      >
        <Menu className="w-4 h-4" />
      </button>

      {isWindowMenuOpen && (
        <div className="titlebar-window-menu-popover">
          <div className="titlebar-window-menu-sections">
            {windowMenuSections.map((section) => (
              <div
                key={section.key}
                className={`titlebar-window-menu-section-node ${
                  activeWindowMenuSection === section.key ? "active" : ""
                }`}
                onMouseEnter={() => {
                  setActiveWindowMenuSection(section.key);
                  setActiveWindowMenuItemPath(null);
                }}
                onFocus={() => {
                  setActiveWindowMenuSection(section.key);
                  setActiveWindowMenuItemPath(null);
                }}
              >
                <button
                  type="button"
                  className={`titlebar-window-menu-section-item ${
                    activeWindowMenuSection === section.key ? "active" : ""
                  }`}
                  onClick={() => {
                    setActiveWindowMenuSection(section.key);
                    setActiveWindowMenuItemPath(null);
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
                          onMouseEnter={() => setActiveWindowMenuItemPath(null)}
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
                                }%, var(--bg-hover) ${
                                  (((item.value ?? 100) - (item.min ?? UI_FONT_SCALE_MIN)) /
                                    Math.max(1, (item.max ?? UI_FONT_SCALE_MAX) - (item.min ?? UI_FONT_SCALE_MIN))) *
                                  100
                                }%)`,
                              }}
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                if (!Number.isNaN(val)) {
                                  item.onValueChange?.(val);
                                }
                              }}
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
                          key={`${section.key}-${item.label || index}`}
                          className="titlebar-window-menu-item-wrapper"
                          onMouseEnter={() => setActiveWindowMenuItemPath(item.label ?? null)}
                        >
                          <button
                            type="button"
                            className="titlebar-window-menu-item"
                            disabled={item.disabled}
                            onClick={() => {
                              if (!item.children) {
                                item.action?.();
                              }
                            }}
                          >
                            <span className="titlebar-window-menu-item-content">
                              {item.selected ? (
                                <Check className="w-3.5 h-3.5 text-accent" />
                              ) : (
                                <span className="w-3.5 h-3.5" />
                              )}
                              <span>{item.label}</span>
                            </span>
                            {item.shortcut && (
                              <span className="titlebar-window-menu-item-shortcut">
                                {item.shortcut}
                              </span>
                            )}
                            {item.children && <ChevronRight className="w-3.5 h-3.5" />}
                          </button>

                          {item.children && activeWindowMenuItemPath === item.label && (
                            <div className="titlebar-window-menu-nested">
                              {item.children.map((child, childIndex) =>
                                child.divider ? (
                                  <div
                                    key={`nested-divider-${childIndex}`}
                                    className="titlebar-window-menu-divider"
                                  />
                                ) : (
                                  <button
                                    key={`nested-${child.label || childIndex}`}
                                    type="button"
                                    className="titlebar-window-menu-item"
                                    disabled={child.disabled}
                                    onClick={() => {
                                      child.action?.();
                                    }}
                                  >
                                    <span className="titlebar-window-menu-item-content">
                                      {child.selected ? (
                                        <Check className="w-3.5 h-3.5 text-accent" />
                                      ) : (
                                        <span className="w-3.5 h-3.5" />
                                      )}
                                      {child.label}
                                    </span>
                                    {child.shortcut && (
                                      <span className="titlebar-window-menu-item-shortcut">
                                        {child.shortcut}
                                      </span>
                                    )}
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
      )}
    </div>
  );
}
