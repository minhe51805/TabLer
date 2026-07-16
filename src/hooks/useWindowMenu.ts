/**
 * useWindowMenu — Builds the application window menu sections.
 * Encapsulates the menu structure definition so App.tsx stays lean.
 *
 * Menu callbacks are injected via the `actions` config object to avoid
 * the circular-import problem of a self-contained hook.
 */

import { useMemo } from "react";
import { useI18n, type AppLanguagePreference } from "../i18n";
import { useEditorPreferencesStore } from "../stores/editorPreferencesStore";
import { useTheme, ThemeEngine } from "../stores/useTheme";
import { UI_FONT_SCALE_MAX, UI_FONT_SCALE_MIN, UI_FONT_SCALE_STEP } from "../utils/ui-scale";
import type { WindowMenuSectionKey, WindowMenuItem } from "../types/app-types";

// ─── Action interface ─────────────────────────────────────────────────────────

export interface WindowMenuActions {
  readonly onNewConnection: () => void;
  readonly onOpenDatabaseFile: () => void;
  readonly onImportSqlFile: () => void;
  readonly onImportSqlIntoCurrentDatabase: () => void;
  readonly onExportDatabase: () => void;
  readonly onOpenMetricsBoard: () => void;
  readonly onCloseWindow: () => void;
  readonly onNewQuery: () => void;
  readonly onToggleSidebar: () => void;
  readonly onToggleTerminalPanel: () => void;
  readonly onToggleQueryResultsPane: () => void;
  readonly onToggleRightSidebar: () => void;
  readonly onToggleBottomSidebar: () => void;
  readonly onFocusExplorerSearch: () => void;
  readonly onShowDatabaseWorkspace: () => void;
  readonly onRefreshWorkspace: () => void;
  readonly onSearchInDatabase: () => void;
  readonly onSetFontSize: (scale: number) => void;
  readonly onIncreaseFontSize: () => void;
  readonly onDecreaseFontSize: () => void;
  readonly onActivateTheme: (themeId: string) => void;
  readonly onOpenUserManagement: () => void;
  readonly onOpenProcessList: () => void;
  readonly onOpenAISettings: () => void;
  readonly onOpenAISlidePanel: () => void;
  readonly onOpenPluginManager: () => void;
  readonly onOpenMcpIntegrations: () => void;
  readonly onOpenAboutModal: () => void;
  readonly onOpenKeyboardShortcuts: () => void;
  readonly onToggleQueryHistory: () => void;
  readonly onOpenConnectionExporter: () => void;
  readonly onOpenConnectionImporter: () => void;
  readonly onChangeLanguage: (lang: AppLanguagePreference) => void;
  readonly onWindowMenuClose: () => void;
}

export interface WindowMenuState {
  readonly isConnected: boolean;
  readonly supportsSqlFileActions: boolean;
  readonly activeTabType?: string;
  readonly uiFontScale: number;
  readonly languagePreference: AppLanguagePreference;
  readonly connectionsCount: number;
}

export interface UseWindowMenuOptions {
  readonly state: WindowMenuState;
  readonly actions: WindowMenuActions;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useWindowMenu({ state, actions }: UseWindowMenuOptions) {
  const { t, language } = useI18n();
  const vimModeEnabled = useEditorPreferencesStore((s) => s.vimModeEnabled);
  const { theme: activeTheme } = useTheme();
  // Option A: MiniMax is the single global look. The theme menu simply lists
  // whatever ThemeEngine exposes (MiniMax + any user-imported themes); the old
  // dark-preset allow-list was removed since those presets were retired.
  const themeMenuOptions = useMemo(
    () => ThemeEngine.getAvailableThemes(),
    []
  );

  const { isConnected, supportsSqlFileActions, activeTabType, uiFontScale, languagePreference, connectionsCount } = state;

  const closeMenu = actions.onWindowMenuClose;

  const themeMenuLabel =
    language === "vi" ? "Giao diện" :
    language === "zh" ? "主题" :
    language === "tr" ? "Tema" :
    language === "ko" ? "테마" :
    "Theme";

  const toggleTerminalLabel =
    language === "vi" ? "Bật/tắt terminal" :
    language === "zh" ? "切换终端" :
    language === "tr" ? "Terminali aç/kapa" :
    language === "ko" ? "터미널 전환" :
    "Toggle Terminal";

  const menuSections = useMemo<{ key: WindowMenuSectionKey; label: string; items: WindowMenuItem[] }[]>(
    () => [
      {
        key: "file",
        label: t("menu.section.file"),
        items: [
          { label: t("menu.item.newConnection"), action: () => { actions.onNewConnection(); closeMenu(); } },
          { label: t("menu.item.newQuery"), action: () => { actions.onNewQuery(); closeMenu(); }, disabled: !isConnected },
          { label: t("menu.item.openDatabaseFile"), action: () => { actions.onOpenDatabaseFile(); closeMenu(); }, shortcut: "Ctrl+Shift+O" },
          { label: t("menu.item.openSqlFile"), action: () => { actions.onImportSqlFile(); closeMenu(); }, shortcut: "Ctrl+O", disabled: !supportsSqlFileActions },
          { label: t("menu.item.importSqlIntoDatabase"), action: () => { actions.onImportSqlIntoCurrentDatabase(); closeMenu(); }, disabled: !supportsSqlFileActions },
          { label: t("menu.item.exportDatabase"), action: () => { actions.onExportDatabase(); closeMenu(); }, disabled: !isConnected },
          { divider: true },
          { label: t("menu.item.exportConnections"), action: () => { actions.onOpenConnectionExporter(); closeMenu(); }, disabled: connectionsCount === 0 },
          { label: t("menu.item.importConnections"), action: () => { actions.onOpenConnectionImporter(); closeMenu(); } },
          { divider: true },
          { label: t("menu.item.openSqlFavorites"), action: () => { actions.onToggleQueryHistory(); closeMenu(); }, shortcut: "Ctrl+Shift+S" },
          { divider: true },
          { label: t("menu.item.openMetrics"), action: () => { actions.onOpenMetricsBoard(); closeMenu(); }, disabled: !isConnected },
          { divider: true },
          { label: t("menu.item.exit"), action: () => { actions.onCloseWindow(); closeMenu(); } },
        ],
      },
      {
        key: "edit",
        label: t("menu.section.edit"),
        items: [
          { label: t("menu.item.aiSettings"), action: () => { actions.onOpenAISettings(); closeMenu(); } },
          { label: t("menu.item.askAI"), action: () => { actions.onOpenAISlidePanel(); closeMenu(); }, disabled: !isConnected },
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
            onValueChange: (v) => { actions.onSetFontSize(v); closeMenu(); },
            onDecrease: () => { actions.onDecreaseFontSize(); closeMenu(); },
            onIncrease: () => { actions.onIncreaseFontSize(); closeMenu(); },
          },
          { divider: true },
          {
            key: "toggle-vim-mode",
            label: t("menu.item.toggleVimMode"),
            action: () => { useEditorPreferencesStore.getState().toggleVimMode(); closeMenu(); },
            selected: vimModeEnabled,
            shortcut: "Ctrl Shift V",
          },
          { divider: true },
          {
            key: "toggle-sidebars",
            label: t("menu.item.toggleSidebars"),
            children: [
              { key: "toggle-left-sidebar", label: t("menu.item.toggleLeftSidebar"), action: () => { actions.onToggleSidebar(); closeMenu(); }, shortcut: "Ctrl 0" },
              { key: "toggle-right-sidebar", label: t("menu.item.toggleRightSidebar"), action: () => { actions.onToggleRightSidebar(); closeMenu(); }, shortcut: "Ctrl Space" },
              { key: "toggle-bottom-sidebar", label: t("menu.item.toggleBottomSidebar"), action: () => { actions.onToggleBottomSidebar(); closeMenu(); }, shortcut: "Ctrl Shift C" },
              { key: "toggle-terminal-panel", label: toggleTerminalLabel, action: () => { actions.onToggleTerminalPanel(); closeMenu(); }, shortcut: "Ctrl `" },
              { key: "toggle-query-results-pane", label: t("menu.item.toggleQueryResultsPane"), action: () => { actions.onToggleQueryResultsPane(); closeMenu(); }, disabled: activeTabType !== "query", shortcut: "Ctrl Shift `" },
            ],
          },
          {
            key: "theme",
            label: themeMenuLabel,
            children: themeMenuOptions.map((option) => ({
              key: option.id,
              label: option.name,
              action: () => { actions.onActivateTheme(option.id); closeMenu(); },
              selected: activeTheme.id === option.id,
            })),
          },
        ],
      },
      {
        key: "tools",
        label: t("menu.section.tools"),
        items: [
          { label: t("menu.item.userManagement"), action: () => { actions.onOpenUserManagement(); closeMenu(); }, disabled: !isConnected },
          { label: t("menu.item.processList"), action: () => { actions.onOpenProcessList(); closeMenu(); }, disabled: !isConnected, shortcut: "Ctrl ." },
          { divider: true },
          { label: t("menu.item.searchInDatabase"), action: () => { actions.onSearchInDatabase(); closeMenu(); }, disabled: !isConnected },
          { divider: true },
          { label: t("menu.item.refreshWorkspace"), action: () => { actions.onRefreshWorkspace(); closeMenu(); }, disabled: !isConnected },
          { label: t("menu.item.focusExplorerSearch"), action: () => { actions.onFocusExplorerSearch(); closeMenu(); }, disabled: !isConnected },
        ],
      },
      {
        key: "connection",
        label: t("menu.section.connection"),
        items: [
          { label: t("menu.item.openExplorer"), action: () => { actions.onShowDatabaseWorkspace(); closeMenu(); }, disabled: !isConnected },
          { label: t("menu.item.openMetrics"), action: () => { actions.onOpenMetricsBoard(); closeMenu(); }, disabled: !isConnected },
        ],
      },
      {
        key: "plugins",
        label: t("menu.section.plugins"),
        items: [
          { label: t("menu.item.askAI"), action: () => { actions.onOpenAISlidePanel(); closeMenu(); }, disabled: !isConnected },
          { label: t("menu.item.pluginManager"), action: () => { actions.onOpenPluginManager(); closeMenu(); } },
          { label: t("menu.item.externalIntegrations"), action: () => { actions.onOpenMcpIntegrations(); closeMenu(); } },
        ],
      },
      {
        key: "navigate",
        label: t("menu.section.navigate"),
        items: [
          { label: t("menu.item.explorer"), action: () => { actions.onShowDatabaseWorkspace(); closeMenu(); }, disabled: !isConnected },
          { label: t("menu.item.metrics"), action: () => { actions.onOpenMetricsBoard(); closeMenu(); }, disabled: !isConnected },
          { label: t("menu.item.queryHistory"), action: () => { actions.onToggleQueryHistory(); closeMenu(); }, shortcut: "Ctrl+H" },
        ],
      },
      {
        key: "language",
        label: t("menu.section.language"),
        items: [
          { label: t("common.auto"), action: () => { actions.onChangeLanguage("auto"); }, selected: languagePreference === "auto" },
          { label: t("common.englishUs"), action: () => { actions.onChangeLanguage("en"); }, selected: languagePreference === "en" },
          { label: t("common.vietnamese"), action: () => { actions.onChangeLanguage("vi"); }, selected: languagePreference === "vi" },
          { label: t("common.chineseSimplified"), action: () => { actions.onChangeLanguage("zh"); }, selected: languagePreference === "zh" },
          { label: t("common.turkish"), action: () => { actions.onChangeLanguage("tr"); }, selected: languagePreference === "tr" },
          { label: t("common.korean"), action: () => { actions.onChangeLanguage("ko"); }, selected: languagePreference === "ko" },
        ],
      },
      {
        key: "help",
        label: t("menu.section.help"),
        items: [
          { label: t("menu.item.aboutTableR"), action: () => { actions.onOpenAboutModal(); closeMenu(); } },
          { label: t("menu.item.keyboardShortcuts"), action: () => { actions.onOpenKeyboardShortcuts(); closeMenu(); } },
        ],
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      t, isConnected, supportsSqlFileActions, connectionsCount, uiFontScale, vimModeEnabled,
      themeMenuLabel, toggleTerminalLabel, themeMenuOptions, activeTheme.id,
      languagePreference, activeTabType, actions, closeMenu,
    ]
  );

  return { menuSections };
}
