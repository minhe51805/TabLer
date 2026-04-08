import {
  useState,
  useEffect,
  useRef,
  useCallback,
  lazy,
  Suspense,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  CheckCircle2,
  Copy,
  Info,
  LoaderCircle,
  Minus,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "./stores/appStore";
import { EventCenter } from "./stores/event-center";
import { getLastPathSegment } from "./utils/path-utils";
import { ThemeEngine, useTheme } from "./stores/useTheme";
import { useEditorPreferencesStore } from "./stores/editorPreferencesStore";
import { useI18n, type AppLanguagePreference } from "./i18n";
import { StartupConnectionManager } from "./components/StartupConnectionManager";
import type { QueryEditorSessionState } from "./components/SQLEditor";
import { AppTitleBar } from "./components/AppTitleBar";
import { AppKeyboardHandler } from "./components/AppKeyboardHandler";
import { AppAboutModal } from "./components/AppAboutModal";
import { AppPluginManagerModal } from "./components/AppPluginManagerModal";
import { AppShortcutsModal } from "./components/AppShortcutsModal";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { QueryHistoryPanel } from "./components/QueryHistory/QueryHistoryPanel";
import { SQLFavoritesPanel } from "./components/SQLFavorites/SQLFavoritesPanel";
import { RowInspector, type RowInspectorData } from "./components/RowInspector/RowInspector";
import { CommandPalette } from "./components/CommandPalette/CommandPalette";
import { QuickSwitcher } from "./components/QuickSwitcher/QuickSwitcher";
import { ThemeCustomizer } from "./components/ThemeCustomizer/ThemeCustomizer";
import { SafeModeConfirmDialog } from "./components/SafeMode/SafeModeConfirmDialog";
import { ConnectionExporter, ConnectionImporter } from "./components/ConnectionExporter";
import { useCommandPaletteStore } from "./stores/commandPaletteStore";
import { useQuickSwitcherStore } from "./stores/quickSwitcherStore";
import { getAdminQueryPreset, type AdminQueryKind } from "./utils/admin-query-presets";
import { APP_TOAST_EVENT, type AppToastPayload, emitAppToast } from "./utils/app-toast";
import { invokeMutation } from "./utils/tauri-utils";
import { getNewQueryTabTitle, getQueryProfile } from "./utils/query-profile";
import { buildDatabaseFileConnection, type DatabaseFileSelection } from "./utils/database-file";
import { splitSqlStatements } from "./utils/sqlStatements";
import { UI_FONT_SCALE_MAX, UI_FONT_SCALE_MIN, UI_FONT_SCALE_STEP } from "./utils/ui-scale";
import "./index.css";
import "./App.css";

interface QueryChromeState {
  isRunning: boolean;
  executionTimeMs?: number;
  rowCount?: number;
  affectedRows?: number;
  queryCount?: number;
}

interface WorkspaceActivityState {
  label: string;
  durationMs: number;
  at: number;
}

interface GlobalToastState {
  id: number;
  tone: "success" | "info" | "error";
  title: string;
  description?: string;
  isClosing: boolean;
}

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

// --- DeepLink type definitions ---
interface DeepLinkConnectPayload {
  action: "connect";
  host?: string;
  port?: number;
  database?: string;
  db_type?: string;
  user?: string;
  password?: string;
}

interface DeepLinkQueryPayload {
  action: "query";
  connection?: string;
  sql?: string;
}

interface DeepLinkTablePayload {
  action: "table";
  connection?: string;
  database?: string;
  table?: string;
}

type DeepLinkPayload = DeepLinkConnectPayload | DeepLinkQueryPayload | DeepLinkTablePayload;

const GLOBAL_ERROR_AUTO_DISMISS_MS = 8000;
const GLOBAL_TOAST_AUTO_DISMISS_MS = 4200;
const GLOBAL_TOAST_EXIT_MS = 220;
const RECOVERABLE_CONNECTION_ERROR_DELAY_MS = 3000;
const UI_FONT_SCALE_STORAGE_KEY = "tabler.uiFontScale";
const DEFAULT_WINDOW_MENU_SECTION: WindowMenuSectionKey = "file";
const RECOVERABLE_CONNECTION_ERROR_PATTERNS = [/please connect first/i];
import { ConnectionForm } from "./components/ConnectionForm";
const AISettingsModal = lazy(() => import("./components/AISettingsModal").then((module) => ({ default: module.AISettingsModal })));
const AISlidePanel = lazy(() => import("./components/AISlidePanel/AISlidePanel").then((module) => ({ default: module.AISlidePanel })));
const AppWorkspacePanel = lazy(() =>
  import("./components/AppWorkspacePanel").then((module) => ({ default: module.AppWorkspacePanel })),
);

function isRecoverableConnectionError(error: string | null) {
  if (!error) return false;
  return RECOVERABLE_CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

function WorkspaceBootFallback() {
  return (
    <div className="workspace-empty">
      <div className="workspace-empty-panel workspace-connecting-panel">
        <div className="workspace-empty-hero">
          <div className="workspace-empty-icon workspace-ready-icon">
            <LoaderCircle className="workspace-empty-glyph w-10 h-10 animate-spin" />
          </div>

          <div className="workspace-empty-copy">
            <span className="workspace-empty-kicker">Workspace</span>
            <h2 className="workspace-empty-title">Loading workspace shell</h2>
            <p className="workspace-empty-description">
              Preparing panels, editors, and database tools.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const { language, languagePreference, setLanguage, t } = useI18n();
  const { theme: activeTheme, activateTheme } = useTheme();
  const {
    activeConnectionId,
    connectedIds,
    connections,
    tabs,
    activeTabId,
    currentDatabase,
    isConnecting,
    error,
    clearError,
    setError,
    loadSavedConnections,
    addTab,
    setActiveTab,
    fetchDatabases,
    fetchTables,
    fetchSchemaObjects,
  } = useAppStore(
    useShallow((state) => ({
      activeConnectionId: state.activeConnectionId,
      connectedIds: state.connectedIds,
      connections: state.connections,
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      currentDatabase: state.currentDatabase,
      isConnecting: state.isConnecting,
      error: state.error,
      clearError: state.clearError,
      setError: state.setError,
      loadSavedConnections: state.loadSavedConnections,
      addTab: state.addTab,
      setActiveTab: state.setActiveTab,
      fetchDatabases: state.fetchDatabases,
      fetchTables: state.fetchTables,
      fetchSchemaObjects: state.fetchSchemaObjects,
    }))
  );

  const [connectionFormIntent, setConnectionFormIntent] = useState<"connect" | "bootstrap" | null>(null);
  const [showStartupConnectionManager, setShowStartupConnectionManager] = useState(true);
  const [showAISettings, setShowAISettings] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [showPluginManager, setShowPluginManager] = useState(false);
  const [showKeyboardShortcutsModal, setShowKeyboardShortcutsModal] = useState(false);
  const [showAISlidePanel, setShowAISlidePanel] = useState(false);
  const [hasMountedAISlidePanel, setHasMountedAISlidePanel] = useState(false);
  const [showTerminalPanel, setShowTerminalPanel] = useState(false);
  const [showQueryHistory, setShowQueryHistory] = useState(false);
  const [showSQLFavorites, setShowSQLFavorites] = useState(false);
  const [showRowInspector, setShowRowInspector] = useState(false);
  const [rowInspectorData, setRowInspectorData] = useState<RowInspectorData | null>(null);
  const [isExportingDatabase, setIsExportingDatabase] = useState(false);
  const [aiPanelDraft, setAiPanelDraft] = useState<{ prompt: string; nonce: number } | null>(null);
  const [leftPanel, setLeftPanel] = useState<"database" | "metrics">("database");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [isWindowFocused, setIsWindowFocused] = useState(true);
  const [queryChromeByTab, setQueryChromeByTab] = useState<Record<string, QueryChromeState>>({});
  const [querySessionByTab, setQuerySessionByTab] = useState<Record<string, QueryEditorSessionState>>({});
  const [queryRunRequestByTab, setQueryRunRequestByTab] = useState<Record<string, number>>({});
  const [workspaceActivityByConnection, setWorkspaceActivityByConnection] = useState<
    Record<string, WorkspaceActivityState>
  >({});
  const [globalToast, setGlobalToast] = useState<GlobalToastState | null>(null);
  const [isRecoverableErrorDelayActive, setIsRecoverableErrorDelayActive] = useState(false);
  const [forceLauncherVisible, setForceLauncherVisible] = useState(false);
  const [isWindowMenuOpen, setIsWindowMenuOpen] = useState(false);
  const [activeWindowMenuSection, setActiveWindowMenuSection] =
    useState<WindowMenuSectionKey | null>(null);
  const [activeWindowMenuItemPath, setActiveWindowMenuItemPath] = useState<string | null>(null);
  const [uiFontScale, setUiFontScale] = useState(() => {
    if (typeof window === "undefined") return 100;
    const stored = Number(window.localStorage.getItem(UI_FONT_SCALE_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= UI_FONT_SCALE_MIN && stored <= UI_FONT_SCALE_MAX ? stored : 100;
  });
  const vimModeEnabled = useEditorPreferencesStore((state) => state.vimModeEnabled);
  const toggleVimMode = useEditorPreferencesStore((state) => state.toggleVimMode);
  const { open: openCommandPalette } = useCommandPaletteStore();
  const { open: openQuickSwitcher } = useQuickSwitcherStore();
  const [showThemeCustomizer, setShowThemeCustomizer] = useState(false);
  const [showConnectionExporter, setShowConnectionExporter] = useState(false);
  const [showConnectionImporter, setShowConnectionImporter] = useState(false);

  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(300);
  const windowMenuRef = useRef<HTMLDivElement | null>(null);
  const windowSyncGenerationRef = useRef(0);
  const globalToastIdRef = useRef(0);
  const globalToastHideTimeoutRef = useRef<number | null>(null);
  const globalToastClearTimeoutRef = useRef<number | null>(null);
  const recoverableConnectionErrorTimeoutRef = useRef<number | null>(null);
  const recoveredConnectionErrorRef = useRef<string | null>(null);
  const isDesktopWindow = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const activeConn = connections.find((conn) => conn.id === activeConnectionId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;
  const hasRenderableWorkspace = !!(activeConnectionId && activeConn && connectedIds.has(activeConnectionId));
  const isConnected = hasRenderableWorkspace;
  const shouldForceStartupLauncher =
    !isRecoverableErrorDelayActive &&
    !isConnecting &&
    !connectionFormIntent &&
    (!activeConnectionId || !activeConn || !connectedIds.has(activeConnectionId));
  const showStartupShell =
    forceLauncherVisible ||
    (!isRecoverableErrorDelayActive &&
      (shouldForceStartupLauncher ||
        (!isConnected && !isConnecting && (showStartupConnectionManager || !!connectionFormIntent))));
  const isMetricsWorkspace = activeTab?.type === "metrics";
  const activeQueryChrome =
    activeTab?.type === "query" ? queryChromeByTab[activeTab.id] ?? { isRunning: false } : null;
  const activeWorkspaceActivity =
    activeConnectionId ? workspaceActivityByConnection[activeConnectionId] ?? null : null;
  const activeQueryProfile = getQueryProfile(activeConn?.db_type);
  const supportsSqlFileActions = !!(activeConnectionId && activeConn && activeQueryProfile.surface === "sql");
  const queryTabCount = tabs.filter(
    (tab) => tab.type === "query" && tab.connectionId === activeConnectionId,
  ).length;
  const activeDatabaseLabel =
    activeConn?.db_type === "sqlite" ? getLastPathSegment(currentDatabase) : currentDatabase || "";
  const titlebarContextTitle = `${activeConn?.name || activeConn?.host || ""}${
    currentDatabase ? ` / ${currentDatabase}` : ""
  }`;
  const titlebarContextLabel = `${activeConn?.name || activeConn?.host || ""}${
    activeDatabaseLabel ? ` / ${activeDatabaseLabel}` : ""
  }`;
  const sidebarMinWidth = 300;
  const themeMenuLabel =
    language === "vi" ? "Giao dien" : language === "zh" ? "Zhu ti" : language === "tr" ? "Tema" : language === "ko" ? "테마" : "Theme";
  const toggleTerminalLabel =
    language === "vi" ? "Bat/tat terminal" : language === "zh" ? "Toggle terminal" : language === "tr" ? "Terminali ac/kapa" : language === "ko" ? "터미널 전환" : "Toggle Terminal";
  const themeMenuOptions = ThemeEngine.getAvailableThemes().filter((option) =>
    ["tabler.dark", "tabler.midnight", "tabler.graphite", "tabler.forest"].includes(option.id),
  );

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${uiFontScale}%`;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(UI_FONT_SCALE_STORAGE_KEY, String(uiFontScale));
    }
  }, [uiFontScale]);

  useEffect(() => {
    if (!error) return;

    const timeoutId = window.setTimeout(() => {
      clearError();
    }, GLOBAL_ERROR_AUTO_DISMISS_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [clearError, error]);

  const clearGlobalToastTimers = useCallback(() => {
    if (globalToastHideTimeoutRef.current !== null) {
      window.clearTimeout(globalToastHideTimeoutRef.current);
      globalToastHideTimeoutRef.current = null;
    }
    if (globalToastClearTimeoutRef.current !== null) {
      window.clearTimeout(globalToastClearTimeoutRef.current);
      globalToastClearTimeoutRef.current = null;
    }
  }, []);

  const dismissGlobalToast = useCallback(() => {
    clearGlobalToastTimers();
    setGlobalToast((current) => (current ? { ...current, isClosing: true } : current));
    globalToastClearTimeoutRef.current = window.setTimeout(() => {
      setGlobalToast(null);
      globalToastClearTimeoutRef.current = null;
    }, GLOBAL_TOAST_EXIT_MS);
  }, [clearGlobalToastTimers]);

  useEffect(() => {
    const handleGlobalToast = (event: Event) => {
      const detail = (event as CustomEvent<AppToastPayload>).detail;
      if (!detail?.title) return;

      clearGlobalToastTimers();

      const toastId = ++globalToastIdRef.current;
      const durationMs = Math.max(detail.durationMs ?? GLOBAL_TOAST_AUTO_DISMISS_MS, GLOBAL_TOAST_EXIT_MS + 120);

      setGlobalToast({
        id: toastId,
        tone: detail.tone ?? "info",
        title: detail.title,
        description: detail.description,
        isClosing: false,
      });

      globalToastHideTimeoutRef.current = window.setTimeout(() => {
        setGlobalToast((current) =>
          current?.id === toastId ? { ...current, isClosing: true } : current,
        );
        globalToastHideTimeoutRef.current = null;
      }, Math.max(0, durationMs - GLOBAL_TOAST_EXIT_MS));

      globalToastClearTimeoutRef.current = window.setTimeout(() => {
        setGlobalToast((current) => (current?.id === toastId ? null : current));
        globalToastClearTimeoutRef.current = null;
      }, durationMs);
    };

    window.addEventListener(APP_TOAST_EVENT, handleGlobalToast);

    return () => {
      clearGlobalToastTimers();
      window.removeEventListener(APP_TOAST_EVENT, handleGlobalToast);
    };
  }, [clearGlobalToastTimers]);

  // Row inspector event handlers
  const handleRowInspectorOpen = useCallback((detail: {
    rowIndex: number;
    row: (string | number | boolean | null)[];
    columns: import("./components/DataGrid/hooks/useDataGrid").ResolvedColumn[];
    primaryKeyValues: Record<string, string | number | boolean | null>;
    tableName?: string;
    database?: string;
  }) => {
    setRowInspectorData({
      rowIndex: detail.rowIndex,
      row: detail.row,
      columns: detail.columns,
      primaryKeyValues: detail.primaryKeyValues,
      tableName: detail.tableName,
      database: detail.database,
    });
    setShowRowInspector(true);
  }, []);

  const handleRowInspectorClose = useCallback(() => {
    setShowRowInspector(false);
  }, []);

  useEffect(() => {
    const offOpen = EventCenter.on("row-inspector-open", (e) => handleRowInspectorOpen(e.detail));
    const offClose = EventCenter.on("row-inspector-close", () => handleRowInspectorClose());
    return () => {
      offOpen();
      offClose();
    };
  }, [handleRowInspectorOpen, handleRowInspectorClose]);

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

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      if (isSidebarCollapsed) return;

      isResizing.current = true;
      startX.current = e.clientX;
      startWidth.current = sidebarWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [isSidebarCollapsed, sidebarWidth],
  );

  const handleNewQuery = useCallback(() => {
    if (!activeConnectionId) return;

    const nextIndex = queryTabCount + 1;
    const queryProfile = getQueryProfile(activeConn?.db_type);
    addTab({
      id: `query-${crypto.randomUUID()}`,
      type: "query",
      title: getNewQueryTabTitle(activeConn?.db_type, nextIndex),
      connectionId: activeConnectionId,
      database: currentDatabase || undefined,
      content: queryProfile.defaultContent,
    });
  }, [activeConn?.db_type, activeConnectionId, addTab, currentDatabase, queryTabCount]);

  const applyDesktopWindowProfile = useCallback(
    async (profile: "launcher" | "form" | "workspace") => {
      if (!isDesktopWindow) return;
      await invoke("apply_window_profile", { profile });
    },
    [isDesktopWindow],
  );

  useEffect(() => {
    if (!error) {
      if (isRecoverableErrorDelayActive) return;
      recoveredConnectionErrorRef.current = null;
      return;
    }

    if (!isRecoverableConnectionError(error) || isConnecting) return;
    if (isRecoverableErrorDelayActive || recoverableConnectionErrorTimeoutRef.current !== null) return;
    if (recoveredConnectionErrorRef.current === error) return;

    recoveredConnectionErrorRef.current = error;
    setForceLauncherVisible(false);
    setIsRecoverableErrorDelayActive(true);

    if (recoverableConnectionErrorTimeoutRef.current !== null) {
      window.clearTimeout(recoverableConnectionErrorTimeoutRef.current);
    }

    recoverableConnectionErrorTimeoutRef.current = window.setTimeout(() => {
      const currentState = useAppStore.getState();
      const staleConnectionId = currentState.activeConnectionId;
      if (staleConnectionId) {
        const nextConnectedIds = new Set(currentState.connectedIds);
        nextConnectedIds.delete(staleConnectionId);
        useAppStore.setState({
          activeConnectionId: null,
          connectedIds: nextConnectedIds,
          currentDatabase: null,
          databases: [],
          tables: [],
          schemaObjects: [],
        });
      }
      setShowStartupConnectionManager(true);
      setConnectionFormIntent(null);
      setShowAISlidePanel(false);
      setIsWindowMenuOpen(false);
      setActiveWindowMenuSection(null);
      setActiveWindowMenuItemPath(null);
      setForceLauncherVisible(true);
      setIsRecoverableErrorDelayActive(false);
      recoveredConnectionErrorRef.current = null;
      recoverableConnectionErrorTimeoutRef.current = null;
      clearError();
      void applyDesktopWindowProfile("launcher");
    }, RECOVERABLE_CONNECTION_ERROR_DELAY_MS);
  }, [applyDesktopWindowProfile, clearError, error, isConnecting, isRecoverableErrorDelayActive]);

  useEffect(() => {
    return () => {
      if (recoverableConnectionErrorTimeoutRef.current !== null) {
        window.clearTimeout(recoverableConnectionErrorTimeoutRef.current);
        recoverableConnectionErrorTimeoutRef.current = null;
      }
    };
  }, []);

  const handleOpenConnectionForm = useCallback(
    (intent: "connect" | "bootstrap") => {
      setShowStartupConnectionManager(false);
      setConnectionFormIntent(intent);
      void applyDesktopWindowProfile("form");
    },
    [applyDesktopWindowProfile],
  );

  const handleCloseConnectionForm = useCallback(() => {
    const { activeConnectionId: latestActiveConnectionId, connectedIds: latestConnectedIds } =
      useAppStore.getState();

    setConnectionFormIntent(null);
    if (!latestActiveConnectionId || !latestConnectedIds.has(latestActiveConnectionId)) {
      setShowStartupConnectionManager(true);
      void applyDesktopWindowProfile("launcher");
    }
  }, [applyDesktopWindowProfile]);

  const handleToggleWindowMenu = useCallback((event?: ReactMouseEvent<HTMLElement>) => {
    event?.stopPropagation();
    setIsWindowMenuOpen((current) => {
      const next = !current;
      if (next) {
        setActiveWindowMenuSection(DEFAULT_WINDOW_MENU_SECTION);
        setActiveWindowMenuItemPath(null);
      }
      return next;
    });
  }, []);

  const handleNewConnectionFromMenu = useCallback(() => {
    handleOpenConnectionForm("connect");
    setIsWindowMenuOpen(false);
  }, [handleOpenConnectionForm]);

  const handleRefreshWorkspace = useCallback(async () => {
    if (!activeConnectionId) return;

    await fetchDatabases(activeConnectionId);
    if (currentDatabase) {
      await Promise.all([
        fetchTables(activeConnectionId, currentDatabase),
        fetchSchemaObjects(activeConnectionId, currentDatabase),
      ]);
    }
  }, [activeConnectionId, currentDatabase, fetchDatabases, fetchSchemaObjects, fetchTables]);

  const handleFocusExplorerSearch = useCallback(() => {
    if (!isConnected) return;

    setIsSidebarCollapsed(false);
    setLeftPanel("database");
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("focus-explorer-search"));
    }, 0);
  }, [isConnected]);

  const handleOpenMetricsBoard = useCallback(() => {
    if (!activeConnectionId) return;

    const existingMetricsTab = tabs.find(
      (tab) =>
        tab.type === "metrics" &&
        tab.connectionId === activeConnectionId &&
        (tab.database || "") === (currentDatabase || ""),
    );

    if (existingMetricsTab) {
      setLeftPanel("metrics");
      setActiveTab(existingMetricsTab.id);
      return;
    }

    setLeftPanel("metrics");
    addTab({
      id: `metrics-${crypto.randomUUID()}`,
      type: "metrics",
      title: "Metrics",
      connectionId: activeConnectionId,
      database: currentDatabase || undefined,
    });
  }, [activeConnectionId, addTab, currentDatabase, setActiveTab, tabs]);

  const handleImportSqlFile = useCallback(async () => {
    if (!activeConnectionId || !activeConn) {
      emitAppToast({
        tone: "info",
        title: language === "vi" ? "Chua mo workspace" : "Open a workspace first",
        description:
          language === "vi"
            ? "Hay mo mot ket noi SQL truoc khi nap tep .sql."
            : "Open a SQL workspace before loading a .sql file.",
      });
      return;
    }

    if (getQueryProfile(activeConn.db_type).surface !== "sql") {
      emitAppToast({
        tone: "info",
        title: language === "vi" ? "Engine hien tai khong dung tep .sql" : "SQL files are not used here",
        description:
          language === "vi"
            ? "Engine hien tai dung command surface, khong mo tep .sql theo kieu query."
            : "The current engine uses a command surface, so .sql files are not opened as SQL tabs.",
      });
      return;
    }

    try {
      const result = await invokeMutation<{ file_name: string; content: string }>("read_sql_file", {});
      const fileName = result?.file_name || (result as { fileName?: string } | null)?.fileName || "query.sql";
      if (result?.content) {
        addTab({
          id: `query-${crypto.randomUUID()}`,
          type: "query",
          title: fileName,
          connectionId: activeConnectionId,
          database: currentDatabase || undefined,
          content: result.content,
        });
        emitAppToast({
          tone: "success",
          title: language === "vi" ? "Da mo tep SQL" : "SQL file opened",
          description:
            language === "vi"
              ? `${fileName} da duoc mo thanh mot query tab moi.`
              : `${fileName} was opened in a new query tab.`,
        });
      }
    } catch (e) {
      if (e instanceof Error && e.message !== "No file selected.") {
        console.error("Failed to import SQL file:", e);
      }
    }
  }, [activeConn, activeConnectionId, addTab, currentDatabase, language]);

  const handleImportSqlFileFromMenu = useCallback(() => {
    void handleImportSqlFile();
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, [handleImportSqlFile]);

  const handleImportSqlIntoCurrentDatabase = useCallback(async () => {
    if (!activeConnectionId || !activeConn) {
      emitAppToast({
        tone: "info",
        title: language === "vi" ? "Chua mo workspace" : "Open a workspace first",
        description:
          language === "vi"
            ? "Hay mo mot ket noi SQL truoc khi import tep .sql."
            : "Open a SQL workspace before importing a .sql file.",
      });
      return;
    }

    if (getQueryProfile(activeConn.db_type).surface !== "sql") {
      emitAppToast({
        tone: "info",
        title: language === "vi" ? "Engine hien tai khong ho tro import SQL" : "SQL import is not available here",
        description:
          language === "vi"
            ? "Engine hien tai dung command surface, khong import tep .sql theo kieu SQL database."
            : "The current engine uses a command surface, so .sql import is not available here.",
      });
      return;
    }

    const startedAt = performance.now();

    try {
      const result = await invokeMutation<{ file_name: string; content: string }>("read_sql_file", {});
      const fileName = result?.file_name || (result as { fileName?: string } | null)?.fileName || "import.sql";
      const statements = splitSqlStatements(result?.content || "");
      if (!statements.length) {
        emitAppToast({
          tone: "info",
          title: language === "vi" ? "Tep SQL khong co cau lenh" : "The SQL file is empty",
          description:
            language === "vi"
              ? "Khong tim thay cau lenh nao de import."
              : "No SQL statements were found to import.",
        });
        return;
      }

      for (const statement of statements) {
        await invokeMutation<{ affected_rows?: number }>("execute_query", {
          connectionId: activeConnectionId,
          sql: statement,
        });
      }

      await handleRefreshWorkspace();
      window.dispatchEvent(
        new CustomEvent("workspace-activity", {
          detail: {
            connectionId: activeConnectionId,
            label: language === "vi" ? "Import SQL" : "Import SQL",
            durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
          },
        }),
      );

      emitAppToast({
        tone: "success",
        title: language === "vi" ? "Da import tep SQL" : "SQL import complete",
        description:
          language === "vi"
            ? `${fileName} da duoc ap dung vao ${activeConn.name || currentDatabase || activeConn.db_type}. ${statements.length} cau lenh da chay.`
            : `${fileName} was applied to ${activeConn.name || currentDatabase || activeConn.db_type}. ${statements.length} statements ran.`,
      });
    } catch (e) {
      if (e instanceof Error && e.message === "No file selected.") return;
      const message = e instanceof Error ? e.message : String(e);
      setError(
        language === "vi"
          ? `Khong the import tep SQL: ${message}`
          : `Could not import the SQL file: ${message}`,
      );
      emitAppToast({
        tone: "error",
        title: language === "vi" ? "Import SQL that bai" : "SQL import failed",
        description: message,
      });
    }
  }, [activeConn, activeConnectionId, currentDatabase, handleRefreshWorkspace, language, setError]);

  const handleImportSqlIntoCurrentDatabaseFromMenu = useCallback(() => {
    void handleImportSqlIntoCurrentDatabase();
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, [handleImportSqlIntoCurrentDatabase]);

  const handleOpenDatabaseFile = useCallback(async () => {
    try {
      const selection = await invokeMutation<DatabaseFileSelection>("pick_database_file", {});
      const fileName =
        selection?.file_name || (selection as { fileName?: string } | null)?.fileName || "database";
      const filePath =
        selection?.file_path || (selection as { filePath?: string } | null)?.filePath || "";
      if (!filePath) return;

      const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
      const existingConnection = connections.find((connection) => {
        const candidatePath = (connection.file_path || "").replace(/\\/g, "/").toLowerCase();
        return candidatePath === normalizedPath;
      });

      if (existingConnection) {
        window.dispatchEvent(
          new CustomEvent("launcher-focus-connection", {
            detail: { connectionId: existingConnection.id },
          }),
        );

        if (connectedIds.has(existingConnection.id)) {
          const targetDatabase = existingConnection.database ?? null;
          useAppStore.setState({
            activeConnectionId: existingConnection.id,
            currentDatabase: targetDatabase,
            schemaObjects: [],
            ...(targetDatabase ? {} : { tables: [] }),
          });
          void fetchDatabases(existingConnection.id);
          if (targetDatabase) {
            void fetchTables(existingConnection.id, targetDatabase);
          }
        } else {
          await useAppStore.getState().connectSavedConnection(existingConnection.id);
        }

        await loadSavedConnections();

        emitAppToast({
          tone: "success",
          title: language === "vi" ? "Da dung lai card da luu" : "Reused the saved connection card",
          description:
            language === "vi"
              ? `${fileName} da ton tai trong launcher duoi ten ${existingConnection.name || fileName}.`
              : `${fileName} already exists in the launcher as ${existingConnection.name || fileName}.`,
        });
        return;
      }

      const nextConfig = buildDatabaseFileConnection(
        { file_name: fileName, file_path: filePath },
        `file-${crypto.randomUUID()}`,
      );
      if (!nextConfig) {
        emitAppToast({
          tone: "error",
          title: language === "vi" ? "Khong nhan dien duoc tep database" : "Database file type not recognized",
          description:
            language === "vi"
              ? "TableR hien chi mo truc tiep tep SQLite va DuckDB o launcher."
              : "TableR currently opens SQLite and DuckDB files directly from the launcher.",
        });
        return;
      }

      await useAppStore.getState().connectToDatabase(nextConfig);
      await loadSavedConnections();
      window.dispatchEvent(
        new CustomEvent("launcher-focus-connection", {
          detail: { connectionId: nextConfig.id },
        }),
      );
      emitAppToast({
        tone: "success",
        title: language === "vi" ? "Da mo tep database" : "Database file opened",
        description:
          language === "vi"
            ? `${fileName} da duoc mo thanh workspace moi.`
            : `${fileName} was opened as a workspace.`,
      });
    } catch (e) {
      if (e instanceof Error && e.message === "No file selected.") return;
      const message = e instanceof Error ? e.message : String(e);
      setError(
        language === "vi"
          ? `Khong the mo tep database: ${message}`
          : `Could not open the database file: ${message}`,
      );
      emitAppToast({
        tone: "error",
        title: language === "vi" ? "Mo tep database that bai" : "Opening the database file failed",
        description: message,
      });
    }
  }, [connectedIds, connections, fetchDatabases, fetchTables, language, loadSavedConnections, setError]);

  const handleOpenDatabaseFileFromMenu = useCallback(() => {
    void handleOpenDatabaseFile();
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, [handleOpenDatabaseFile]);

  const handleExportDatabase = useCallback(async () => {
    if (!activeConnectionId || !activeConn || isExportingDatabase) return;

    const startedAt = performance.now();
    setIsExportingDatabase(true);

    try {
      await invokeMutation<{
        filePath: string;
        format: string;
        tableCount: number;
        rowCount: number;
      }>("export_database", {
        connectionId: activeConnectionId,
        database: currentDatabase || null,
        dbType: activeConn.db_type,
        connectionName: activeConn.name || activeConn.host || activeConn.file_path || activeConn.db_type,
      });

      emitAppToast({
        tone: "success",
        title: language === "vi" ? "Da xuat database" : "Database exported",
        description:
          language === "vi"
            ? `${activeConn.name || activeConn.db_type} da duoc xuat thanh cong.`
            : `${activeConn.name || activeConn.db_type} was exported successfully.`,
      });

      window.dispatchEvent(
        new CustomEvent("workspace-activity", {
          detail: {
            connectionId: activeConnectionId,
            label: language === "vi" ? "Export" : "Export",
            durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
          },
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== "No file selected.") {
        setError(
          language === "vi"
            ? `Không thể xuất database: ${message}`
            : `Could not export database: ${message}`,
        );
      }
    } finally {
      setIsExportingDatabase(false);
    }
  }, [activeConn, activeConnectionId, currentDatabase, isExportingDatabase, language, setError]);

  const handleExportDatabaseFromMenu = useCallback(() => {
    void handleExportDatabase();
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, [handleExportDatabase]);

  const handleOpenMetricsBoardFromMenu = useCallback(() => {
    setIsWindowMenuOpen(false);
    void handleOpenMetricsBoard();
  }, [handleOpenMetricsBoard]);

  const handleChangeLanguage = useCallback(
    (nextLanguage: AppLanguagePreference) => {
      setLanguage(nextLanguage);
      setIsWindowMenuOpen(false);
      setActiveWindowMenuItemPath(null);
    },
    [setLanguage],
  );

  const handleSetFontSizeFromMenu = useCallback((next: number) => {
    const normalized = Math.min(
      UI_FONT_SCALE_MAX,
      Math.max(UI_FONT_SCALE_MIN, Math.round(next / UI_FONT_SCALE_STEP) * UI_FONT_SCALE_STEP),
    );
    setUiFontScale(normalized);
    setActiveWindowMenuItemPath(null);
  }, []);

  const handleIncreaseFontSizeInline = useCallback(() => {
    setUiFontScale((current) => Math.min(UI_FONT_SCALE_MAX, current + UI_FONT_SCALE_STEP));
    setActiveWindowMenuItemPath(null);
  }, []);

  const handleDecreaseFontSizeInline = useCallback(() => {
    setUiFontScale((current) => Math.max(UI_FONT_SCALE_MIN, current - UI_FONT_SCALE_STEP));
    setActiveWindowMenuItemPath(null);
  }, []);

  const handleToggleRightSidebarFromMenu = useCallback(() => {
    setShowAISlidePanel((current) => !current);
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, []);

  const handleToggleTerminalPanel = useCallback(() => {
    setShowTerminalPanel((current) => !current);
  }, []);

  const handleToggleTerminalPanelFromMenu = useCallback(() => {
    setShowTerminalPanel((current) => !current);
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, []);

  const handleToggleQueryResultsPaneFromMenu = useCallback(() => {
    if (activeTab?.type !== "query") {
      return;
    }

    window.dispatchEvent(
      new CustomEvent("toggle-query-results-pane", {
        detail: { tabId: activeTab.id },
      }),
    );
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, [activeTab]);

  const handleShowDatabaseWorkspace = useCallback(() => {
    if (!isConnected) return;

    setIsSidebarCollapsed(false);
    setLeftPanel("database");

    const isDatabaseWorkspaceTab = (tab: { type: string }) =>
      tab.type !== "metrics" && tab.type !== "er-diagram";

    const currentDatabaseKey = currentDatabase || "";
    const candidateTab =
      [...tabs]
        .reverse()
        .find(
          (tab) =>
            isDatabaseWorkspaceTab(tab) &&
            tab.connectionId === activeConnectionId &&
            (tab.database || "") === currentDatabaseKey,
        ) ||
      [...tabs]
        .reverse()
        .find((tab) => isDatabaseWorkspaceTab(tab) && tab.connectionId === activeConnectionId) ||
      [...tabs].reverse().find((tab) => isDatabaseWorkspaceTab(tab));

    if (candidateTab) {
      setActiveTab(candidateTab.id);
      return;
    }

    handleNewQuery();
  }, [activeConnectionId, currentDatabase, handleNewQuery, isConnected, setActiveTab, tabs]);

  const handleShowDatabaseWorkspaceFromMenu = useCallback(() => {
    setIsWindowMenuOpen(false);
    handleShowDatabaseWorkspace();
  }, [handleShowDatabaseWorkspace]);

  const handleNewQueryFromMenu = useCallback(() => {
    setIsWindowMenuOpen(false);
    handleNewQuery();
  }, [handleNewQuery]);

  const handleOpenAISettingsFromMenu = useCallback(() => {
    setShowAISettings(true);
    setIsWindowMenuOpen(false);
  }, []);

  const handleOpenAboutModalFromMenu = useCallback(() => {
    setShowAboutModal(true);
    setIsWindowMenuOpen(false);
  }, []);

  const handleOpenKeyboardShortcutsFromMenu = useCallback(() => {
    setShowKeyboardShortcutsModal(true);
    setIsWindowMenuOpen(false);
  }, []);

  const handleRefreshWorkspaceFromMenu = useCallback(() => {
    void handleRefreshWorkspace();
    setIsWindowMenuOpen(false);
  }, [handleRefreshWorkspace]);

  const handleFocusExplorerSearchFromMenu = useCallback(() => {
    handleFocusExplorerSearch();
    setIsWindowMenuOpen(false);
  }, [handleFocusExplorerSearch]);

  const handleSearchInDatabaseFromMenu = useCallback(() => {
    handleShowDatabaseWorkspace();
    window.setTimeout(() => {
      handleFocusExplorerSearch();
    }, 0);
    setIsWindowMenuOpen(false);
  }, [handleFocusExplorerSearch, handleShowDatabaseWorkspace]);

  const handleRunActiveQuery = useCallback(() => {
    if (activeTab?.type !== "query") return;

    setQueryRunRequestByTab((prev) => ({
      ...prev,
      [activeTab.id]: (prev[activeTab.id] ?? 0) + 1,
    }));
  }, [activeTab]);

  const handleClearVisibleTabs = useCallback(() => {
    useAppStore.setState((state) => ({
      tabs: state.tabs.filter((tab) => tab.type === "metrics"),
      activeTabId: null,
    }));
  }, []);

  const handleQueryChromeChange = useCallback((tabId: string, state: QueryChromeState) => {
    setQueryChromeByTab((prev) => {
      const current = prev[tabId];
      if (
        current?.isRunning === state.isRunning &&
        current?.executionTimeMs === state.executionTimeMs &&
        current?.rowCount === state.rowCount &&
        current?.affectedRows === state.affectedRows &&
        current?.queryCount === state.queryCount
      ) {
        return prev;
      }

      return {
        ...prev,
        [tabId]: state,
      };
    });
  }, []);

  const handleQuerySessionChange = useCallback((tabId: string, state: QueryEditorSessionState) => {
    setQuerySessionByTab((prev) => {
      const current = prev[tabId];
      if (
        current?.result === state.result &&
        current?.error === state.error &&
        current?.notice === state.notice &&
        current?.queryCount === state.queryCount &&
        current?.editorHeight === state.editorHeight &&
        current?.showResultsPane === state.showResultsPane
      ) {
        return prev;
      }

      return {
        ...prev,
        [tabId]: state,
      };
    });
  }, []);

  useEffect(() => {
    if (showAISlidePanel) {
      setHasMountedAISlidePanel(true);
    }
  }, [showAISlidePanel]);

  useEffect(() => {
    setQueryChromeByTab((prev) => {
      const activeTabIds = new Set(tabs.filter((tab) => tab.type === "query").map((tab) => tab.id));
      const nextEntries = Object.entries(prev).filter(([tabId]) => activeTabIds.has(tabId));
      if (nextEntries.length === Object.keys(prev).length) {
        return prev;
      }
      return Object.fromEntries(nextEntries);
    });

    setQuerySessionByTab((prev) => {
      const activeTabIds = new Set(tabs.filter((tab) => tab.type === "query").map((tab) => tab.id));
      const nextEntries = Object.entries(prev).filter(([tabId]) => activeTabIds.has(tabId));
      if (nextEntries.length === Object.keys(prev).length) {
        return prev;
      }
      return Object.fromEntries(nextEntries);
    });

    setQueryRunRequestByTab((prev) => {
      const activeTabIds = new Set(tabs.filter((tab) => tab.type === "query").map((tab) => tab.id));
      const nextEntries = Object.entries(prev).filter(([tabId]) => activeTabIds.has(tabId));
      if (nextEntries.length === Object.keys(prev).length) {
        return prev;
      }
      return Object.fromEntries(nextEntries);
    });
  }, [tabs]);

  const handleToggleQueryHistory = useCallback(() => {
    setShowQueryHistory((current) => !current);
  }, []);

  const handleToggleSQLFavorites = useCallback(() => {
    setShowSQLFavorites((current) => !current);
  }, []);

  const handleRunQueryFromHistory = useCallback((sql: string) => {
    window.dispatchEvent(new CustomEvent("insert-sql-from-ai", { detail: { sql } }));
    setShowQueryHistory(false);
  }, []);

  const handleRunQueryFromFavorites = useCallback((sql: string) => {
    window.dispatchEvent(new CustomEvent("insert-sql-from-ai", { detail: { sql } }));
    setShowSQLFavorites(false);
  }, []);

  const handleOpenAdminQuery = useCallback(
    (kind: AdminQueryKind) => {
      if (!activeConnectionId || !activeConn) return;

      const preset = getAdminQueryPreset(activeConn.db_type, kind);
      const itemLabel =
        kind === "process-list" ? t("menu.item.processList") : t("menu.item.userManagement");

      if (!preset.supported || !preset.content.trim()) {
        setError(
          language === "vi"
            ? `${itemLabel.replace(/\.\.\.$/, "")}: ${preset.reason || "Chưa có preset phù hợp cho engine hiện tại."}`
            : `${itemLabel.replace(/\.\.\.$/, "")}: ${preset.reason || "No preset is available for the current engine."}`,
        );
        setIsWindowMenuOpen(false);
        setActiveWindowMenuItemPath(null);
        return;
      }

      const tabId = `query-${crypto.randomUUID()}`;
      const queryTitle = itemLabel.replace(/\.\.\.$/, "");

      addTab({
        id: tabId,
        type: "query",
        title: queryTitle,
        connectionId: activeConnectionId,
        database: currentDatabase || undefined,
        content: preset.content,
      });

      setQueryRunRequestByTab((prev) => ({
        ...prev,
        [tabId]: (prev[tabId] ?? 0) + 1,
      }));
      setIsWindowMenuOpen(false);
      setActiveWindowMenuItemPath(null);
    },
    [activeConn, activeConnectionId, addTab, currentDatabase, language, setError, t],
  );

  const handleOpenProcessListFromMenu = useCallback(() => {
    handleOpenAdminQuery("process-list");
  }, [handleOpenAdminQuery]);

  const handleOpenUserManagementFromMenu = useCallback(() => {
    handleOpenAdminQuery("user-management");
  }, [handleOpenAdminQuery]);

  const handleToggleQueryHistoryFromMenu = useCallback(() => {
    setShowQueryHistory((current) => !current);
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, []);

  const handleToggleSQLFavoritesFromMenu = useCallback(() => {
    setShowSQLFavorites((current) => !current);
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, []);

  const handleOpenPluginManagerFromMenu = useCallback(() => {
    setShowPluginManager(true);
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, []);

  const handleToggleBottomSidebarFromMenu = useCallback(() => {
    if (activeTab?.type === "query") {
      window.dispatchEvent(
        new CustomEvent("toggle-query-results-pane", {
          detail: { tabId: activeTab.id },
        }),
      );
    } else {
      setShowTerminalPanel((current) => !current);
    }
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, [activeTab]);

  const handleOpenAISlidePanel = useCallback((prompt?: string) => {
    if (typeof prompt === "string" && prompt.trim()) {
      setAiPanelDraft({
        prompt,
        nonce: Date.now(),
      });
    }
    setShowAISlidePanel(true);
  }, []);

  const handleOpenAISlidePanelFromMenu = useCallback(() => {
    handleOpenAISlidePanel();
    setIsWindowMenuOpen(false);
  }, [handleOpenAISlidePanel]);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((collapsed) => !collapsed);
  }, []);

  const handleOpenThemeCustomizer = useCallback(() => {
    setShowThemeCustomizer(true);
  }, []);

  const handleMinimizeWindow = useCallback(() => {
    if (!isDesktopWindow) return;

    void (async () => {
      try {
        await getCurrentWindow().minimize();
      } catch (windowError) {
        console.error("Failed to minimize window", windowError);
      }
    })();
  }, [isDesktopWindow]);

  const handleToggleMaximizeWindow = useCallback(() => {
    if (!isDesktopWindow) return;

    void (async () => {
      try {
        const appWindow = getCurrentWindow();
        await appWindow.toggleMaximize();
        setIsWindowMaximized(await appWindow.isMaximized());
      } catch (windowError) {
        console.error("Failed to toggle maximize window", windowError);
      }
    })();
  }, [isDesktopWindow]);

  const handleCloseWindow = useCallback(() => {
    if (!isDesktopWindow) return;

    void (async () => {
      try {
        await getCurrentWindow().close();
      } catch (windowError) {
        console.error("Failed to close window", windowError);
      }
    })();
  }, [isDesktopWindow]);

  const handleCloseWindowFromMenu = useCallback(() => {
    setIsWindowMenuOpen(false);
    handleCloseWindow();
  }, [handleCloseWindow]);

  const handleToggleSidebarFromMenu = useCallback(() => {
    handleToggleSidebar();
    setIsWindowMenuOpen(false);
  }, [handleToggleSidebar]);

  const handleActivateThemeFromMenu = useCallback(
    (themeId: string) => {
      const selectedTheme = themeMenuOptions.find((option) => option.id === themeId);
      if (!selectedTheme) return;
      activateTheme(selectedTheme);
      setIsWindowMenuOpen(false);
      setActiveWindowMenuItemPath(null);
    },
    [activateTheme, themeMenuOptions],
  );

  const windowMenuSections: { key: WindowMenuSectionKey; label: string; items: WindowMenuItem[] }[] = [
    {
      key: "file",
      label: t("menu.section.file"),
      items: [
        { label: t("menu.item.newConnection"), action: handleNewConnectionFromMenu },
        { label: t("menu.item.newQuery"), action: handleNewQueryFromMenu, disabled: !isConnected },
        { label: t("menu.item.openDatabaseFile"), action: handleOpenDatabaseFileFromMenu, shortcut: "Ctrl+Shift+O" },
        { label: t("menu.item.openSqlFile"), action: handleImportSqlFileFromMenu, shortcut: "Ctrl+O", disabled: !supportsSqlFileActions },
        { label: t("menu.item.importSqlIntoDatabase"), action: handleImportSqlIntoCurrentDatabaseFromMenu, disabled: !supportsSqlFileActions },
        { label: t("menu.item.exportDatabase"), action: handleExportDatabaseFromMenu, disabled: !isConnected },
        { divider: true },
        { label: t("menu.item.exportConnections"), action: () => { setShowConnectionExporter(true); setIsWindowMenuOpen(false); setActiveWindowMenuItemPath(null); }, disabled: connections.length === 0 },
        { label: t("menu.item.importConnections"), action: () => { setShowConnectionImporter(true); setIsWindowMenuOpen(false); setActiveWindowMenuItemPath(null); } },
        { divider: true },
        { label: t("menu.item.openSqlFavorites"), action: handleToggleSQLFavoritesFromMenu, shortcut: "Ctrl+Shift+S" },
        { divider: true },
        { label: t("menu.item.openMetrics"), action: handleOpenMetricsBoardFromMenu, disabled: !isConnected },
        { divider: true },
        { label: t("menu.item.exit"), action: handleCloseWindowFromMenu },
      ],
    },
    {
      key: "edit",
      label: t("menu.section.edit"),
      items: [
        { label: t("menu.item.aiSettings"), action: handleOpenAISettingsFromMenu },
        { label: t("menu.item.askAI"), action: handleOpenAISlidePanelFromMenu, disabled: !isConnected },
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
          onValueChange: handleSetFontSizeFromMenu,
          onDecrease: handleDecreaseFontSizeInline,
          onIncrease: handleIncreaseFontSizeInline,
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
              action: handleToggleSidebarFromMenu,
              shortcut: "Ctrl 0",
            },
            {
              key: "toggle-right-sidebar",
              label: t("menu.item.toggleRightSidebar"),
              action: handleToggleRightSidebarFromMenu,
              shortcut: "Ctrl Space",
            },
            {
              key: "toggle-bottom-sidebar",
              label: t("menu.item.toggleBottomSidebar"),
              action: handleToggleBottomSidebarFromMenu,
              shortcut: "Ctrl Shift C",
            },
            {
              key: "toggle-terminal-panel",
              label: toggleTerminalLabel,
              action: handleToggleTerminalPanelFromMenu,
              shortcut: "Ctrl `",
            },
            {
              key: "toggle-query-results-pane",
              label: t("menu.item.toggleQueryResultsPane"),
              action: handleToggleQueryResultsPaneFromMenu,
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
            action: () => handleActivateThemeFromMenu(option.id),
            selected: activeTheme.id === option.id,
          })),
        },
      ],
    },
    {
      key: "tools",
      label: t("menu.section.tools"),
      items: [
        { label: t("menu.item.userManagement"), action: handleOpenUserManagementFromMenu, disabled: !isConnected },
        { label: t("menu.item.processList"), action: handleOpenProcessListFromMenu, disabled: !isConnected, shortcut: "Ctrl ." },
        { divider: true },
        { label: t("menu.item.searchInDatabase"), action: handleSearchInDatabaseFromMenu, disabled: !isConnected },
        { divider: true },
        { label: t("menu.item.refreshWorkspace"), action: handleRefreshWorkspaceFromMenu, disabled: !isConnected },
        { label: t("menu.item.focusExplorerSearch"), action: handleFocusExplorerSearchFromMenu, disabled: !isConnected },
      ],
    },
    {
      key: "connection",
      label: t("menu.section.connection"),
      items: [
        { label: t("menu.item.openExplorer"), action: handleShowDatabaseWorkspaceFromMenu, disabled: !isConnected },
        { label: t("menu.item.openMetrics"), action: handleOpenMetricsBoardFromMenu, disabled: !isConnected },
      ],
    },
    {
      key: "plugins",
      label: t("menu.section.plugins"),
      items: [
        { label: t("menu.item.askAI"), action: handleOpenAISlidePanelFromMenu, disabled: !isConnected },
        { label: t("menu.item.pluginManager"), action: handleOpenPluginManagerFromMenu },
      ],
    },
    {
      key: "navigate",
      label: t("menu.section.navigate"),
      items: [
        { label: t("menu.item.explorer"), action: handleShowDatabaseWorkspaceFromMenu, disabled: !isConnected },
        { label: t("menu.item.metrics"), action: handleOpenMetricsBoardFromMenu, disabled: !isConnected },
        { label: t("menu.item.queryHistory"), action: handleToggleQueryHistoryFromMenu, shortcut: "Ctrl+H" },
      ],
    },
    {
      key: "language",
      label: t("menu.section.language"),
      items: [
        { label: t("common.auto"), action: () => handleChangeLanguage("auto"), selected: languagePreference === "auto" },
        {
          label: t("common.englishUs"),
          action: () => handleChangeLanguage("en"),
          selected: languagePreference === "en",
        },
        {
          label: t("common.vietnamese"),
          action: () => handleChangeLanguage("vi"),
          selected: languagePreference === "vi",
        },
        {
          label: t("common.chineseSimplified"),
          action: () => handleChangeLanguage("zh"),
          selected: languagePreference === "zh",
        },
        {
          label: t("common.turkish"),
          action: () => handleChangeLanguage("tr"),
          selected: languagePreference === "tr",
        },
        {
          label: t("common.korean"),
          action: () => handleChangeLanguage("ko"),
          selected: languagePreference === "ko",
        },
      ],
    },
    {
      key: "help",
      label: t("menu.section.help"),
      items: [
        { label: t("menu.item.aboutTableR"), action: handleOpenAboutModalFromMenu },
        { label: t("menu.item.keyboardShortcuts"), action: handleOpenKeyboardShortcutsFromMenu },
      ],
    },
  ];

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;

      const delta = e.clientX - startX.current;
      const nextWidth = Math.max(sidebarMinWidth, Math.min(460, startWidth.current + delta));
      setSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  useEffect(() => {
    void loadSavedConnections();
  }, [loadSavedConnections]);

  // Deep link handler: restore tabs after a successful connection
  useEffect(() => {
    if (!activeConnectionId || !connectedIds.has(activeConnectionId)) return;

    let cancelled = false;
    const restoreTabs = async () => {
      const store = await import("./stores/appStore").then((m) => m.useAppStore.getState());
      if (cancelled) return;

      const persisted = await store.loadTabState(activeConnectionId);
      if (cancelled || persisted.length === 0) return;

      const activePersistedTab = persisted.find((t) => t.isActive);

      for (const pt of persisted) {
        const newTabId = pt.tabId;
        // Check if tab already exists
        if (store.tabs.some((t) => t.id === newTabId)) continue;

        if (pt.tabType === "query") {
          store.addTab({
            id: newTabId,
            type: pt.tabType,
            title: pt.title,
            connectionId: activeConnectionId,
            database: pt.database,
            content: pt.content,
          });
        } else if (pt.tabType === "table" && pt.tableName) {
          store.addTab({
            id: newTabId,
            type: pt.tabType,
            title: pt.title,
            connectionId: activeConnectionId,
            database: pt.database,
            tableName: pt.tableName,
          });
        } else if (pt.tabType === "structure" && pt.tableName) {
          store.addTab({
            id: newTabId,
            type: pt.tabType,
            title: pt.title,
            connectionId: activeConnectionId,
            database: pt.database,
            tableName: pt.tableName,
          });
        }
      }

      if (activePersistedTab) {
        store.setActiveTab(activePersistedTab.tabId);
      }
    };

    void restoreTabs();
    return () => { cancelled = true; };
  }, [activeConnectionId, connectedIds]);

  // Save tabs on connection when tabs change or app closes
  useEffect(() => {
    if (!activeConnectionId || !connectedIds.has(activeConnectionId)) return;

    const store = useAppStore.getState();
    void store.saveTabState(activeConnectionId);

    const handleBeforeUnload = () => {
      const state = useAppStore.getState();
      if (state.activeConnectionId && state.connectedIds.has(state.activeConnectionId)) {
        void state.saveTabState(state.activeConnectionId);
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [activeConnectionId, connectedIds, tabs]);

  // Deep link handler: listen for tabler:// URLs from the backend
  useEffect(() => {
    if (!isDesktopWindow) return;

    let unlisten: (() => void) | undefined;

    listen<string>("deep-link", async (event: { payload: string }) => {
      const url: string = event.payload;
      try {
        const parsed = await invoke<DeepLinkPayload>("parse_deep_link", { url });

        if (parsed.action === "connect") {
          const conn = parsed as DeepLinkConnectPayload;
          const confirmed = window.confirm(
            `Open TableR and connect to ${conn.host || "database"}:${conn.port || ""}?`
          );
          if (!confirmed) return;

          handleOpenConnectionForm("connect");
          // Dispatch to connection form via event
          window.dispatchEvent(new CustomEvent("tabler-deep-link-connect", {
            detail: {
              host: conn.host,
              port: conn.port,
              database: conn.database,
              dbType: conn.db_type,
              user: conn.user,
              password: conn.password,
            },
          }));
        } else if (parsed.action === "query") {
          const q = parsed as DeepLinkQueryPayload;
          const sql = q.sql || "";
          if (!sql) return;

          if (!isConnected) {
            const confirmed = window.confirm(
              `Open query tab with SQL?\n\n${sql.length > 200 ? sql.slice(0, 200) + "..." : sql}\n\n(Requires an active connection to execute.)`
            );
            if (!confirmed) return;
          }

          if (!isConnected || !activeConnectionId) {
            handleOpenConnectionForm("connect");
            return;
          }

          const tabId = `query-${crypto.randomUUID()}`;
          addTab({
            id: tabId,
            type: "query",
            title: "Deep Link Query",
            connectionId: activeConnectionId,
            database: currentDatabase || undefined,
            content: sql,
          });

          setQueryRunRequestByTab((prev) => ({
            ...prev,
            [tabId]: (prev[tabId] ?? 0) + 1,
          }));
        } else if (parsed.action === "table") {
          const t = parsed as DeepLinkTablePayload;
          const connectionId = t.connection || activeConnectionId;
          if (!connectionId) {
            handleOpenConnectionForm("connect");
            return;
          }

          const tabId = `table-${crypto.randomUUID()}`;
          addTab({
            id: tabId,
            type: "table",
            title: t.table || "Table",
            connectionId,
            database: t.database || currentDatabase || undefined,
            tableName: t.table,
          });
        }
      } catch (err) {
        console.error("[DeepLink] Failed to parse URL:", url, err);
      }
    }).then((off: () => void) => { unlisten = off; });

    return () => { unlisten?.(); };
  }, [isDesktopWindow, isConnected, activeConnectionId, currentDatabase, addTab, setActiveTab, setQueryRunRequestByTab]);

  useEffect(() => {
    const handleOpenAI = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: string }>).detail;
      handleOpenAISlidePanel(detail?.prompt);
    };
    window.addEventListener("open-ai-slide-panel", handleOpenAI);
    return () => window.removeEventListener("open-ai-slide-panel", handleOpenAI);
  }, [handleOpenAISlidePanel]);

  useEffect(() => {
    const handleOpenAISettings = () => {
      setShowAISettings(true);
    };
    window.addEventListener("open-ai-settings", handleOpenAISettings);
    return () => window.removeEventListener("open-ai-settings", handleOpenAISettings);
  }, []);

  useEffect(() => {
    const handleOpenLeftSidebarPanel = (
      event: Event,
    ) => {
      const detail = (event as CustomEvent<{
        panel?: "database" | "metrics";
        focusSearch?: boolean;
      }>).detail;

      if (!detail?.panel) return;

      setIsSidebarCollapsed(false);
      setLeftPanel(detail.panel);

      if (detail.panel === "database" && detail.focusSearch) {
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent("focus-explorer-search"));
        }, 0);
      }
    };

    window.addEventListener("open-left-sidebar-panel", handleOpenLeftSidebarPanel);
    return () =>
      window.removeEventListener("open-left-sidebar-panel", handleOpenLeftSidebarPanel);
  }, []);

  useEffect(() => {
    const handleWorkspaceActivity = (
      event: Event,
    ) => {
      const detail = (event as CustomEvent<{
        connectionId?: string;
        label?: string;
        durationMs?: number;
      }>).detail;

      if (!detail?.connectionId || typeof detail.durationMs !== "number" || detail.durationMs < 0) {
        return;
      }

      const connectionId = detail.connectionId;
      const durationMs = detail.durationMs;

      setWorkspaceActivityByConnection((prev) => ({
        ...prev,
        [connectionId]: {
          label: detail.label?.trim() || "Load",
          durationMs: Math.round(durationMs),
          at: Date.now(),
        },
      }));
    };

    window.addEventListener("workspace-activity", handleWorkspaceActivity);
    return () => window.removeEventListener("workspace-activity", handleWorkspaceActivity);
  }, []);

  useEffect(() => {
    if (!isDesktopWindow) return;

    const appWindow = getCurrentWindow();
    let isMounted = true;
    let unlistenResized: (() => void) | undefined;
    let unlistenFocusChanged: (() => void) | undefined;

    const syncWindowState = async () => {
      const [maximized, focused] = await Promise.all([
        appWindow.isMaximized(),
        appWindow.isFocused(),
      ]);

      if (!isMounted) return;

      setIsWindowMaximized(maximized);
      setIsWindowFocused(focused);
    };

    void syncWindowState();

    void appWindow.onResized(async () => {
      if (!isMounted) return;
      setIsWindowMaximized(await appWindow.isMaximized());
    }).then((unlisten) => {
      unlistenResized = unlisten;
    });

    void appWindow.onFocusChanged(({ payload }) => {
      if (!isMounted) return;
      setIsWindowFocused(payload);
    }).then((unlisten) => {
      unlistenFocusChanged = unlisten;
    });

    return () => {
      isMounted = false;
      unlistenResized?.();
      unlistenFocusChanged?.();
    };
  }, [isDesktopWindow]);

  useEffect(() => {
    setLeftPanel("database");
  }, [activeConnectionId, connectedIds, isConnecting]);

  useEffect(() => {
    if (activeConnectionId && (connectedIds.has(activeConnectionId) || isConnecting)) {
      setForceLauncherVisible(false);
      setShowStartupConnectionManager(false);
      setConnectionFormIntent(null);
    }
  }, [activeConnectionId, connectedIds, isConnecting]);

  useEffect(() => {
    if (isConnected || isConnecting || connectionFormIntent || isRecoverableErrorDelayActive) return;

    setShowStartupConnectionManager(true);
    setShowAISlidePanel(false);
    setIsWindowMenuOpen(false);
    setActiveWindowMenuSection(null);
    setActiveWindowMenuItemPath(null);
  }, [connectionFormIntent, isConnected, isConnecting, isRecoverableErrorDelayActive]);

  useEffect(() => {
    if (!isDesktopWindow || isConnected || isConnecting || isRecoverableErrorDelayActive) return;

    const windowProfile: "launcher" | "form" = connectionFormIntent
      ? "form"
      : "launcher";

    let cancelled = false;
    const syncGeneration = ++windowSyncGenerationRef.current;
    const isStale = () => cancelled || windowSyncGenerationRef.current !== syncGeneration;

    const applyWindowProfile = async () => {
      try {
        if (isStale()) return;

        await applyDesktopWindowProfile(windowProfile);
      } catch (windowError) {
        console.error("Failed to synchronize startup window state", windowError);
      }
    };

    void applyWindowProfile();

    return () => {
      cancelled = true;
    };
  }, [applyDesktopWindowProfile, connectionFormIntent, isConnected, isConnecting, isDesktopWindow, isRecoverableErrorDelayActive]);

  useEffect(() => {
    if (!isDesktopWindow || !isConnected) return;

    let cancelled = false;
    const syncGeneration = ++windowSyncGenerationRef.current;
    const isStale = () => cancelled || windowSyncGenerationRef.current !== syncGeneration;

    const applyWindowProfile = async () => {
      try {
        if (isStale()) return;
        await applyDesktopWindowProfile("workspace");
      } catch (windowError) {
        console.error("Failed to synchronize workspace window state", windowError);
      }
    };

    void applyWindowProfile();

    return () => {
      cancelled = true;
    };
  }, [applyDesktopWindowProfile, isConnected, isDesktopWindow]);

  useEffect(() => {
    if (!activeConnectionId || !connectedIds.has(activeConnectionId)) return;

    if (activeTab?.type === "metrics") {
      setLeftPanel("metrics");
      return;
    }

    setLeftPanel((current) => (current === "metrics" ? "database" : current));
  }, [activeConnectionId, activeTab?.id, activeTab?.type, connectedIds]);

  useEffect(() => {
    if (isSidebarCollapsed) return;
    if (sidebarWidth >= sidebarMinWidth) return;
    setSidebarWidth(sidebarMinWidth);
  }, [isSidebarCollapsed, sidebarMinWidth, sidebarWidth]);

  const globalToastMarkup = globalToast ? (
    <div className="app-toast-region" aria-live="polite" aria-atomic="true">
      <div className={`app-toast ${globalToast.tone} ${globalToast.isClosing ? "closing" : ""}`}>
        <div className={`app-toast-icon ${globalToast.tone}`}>
          {globalToast.tone === "success" ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : globalToast.tone === "error" ? (
            <TriangleAlert className="h-4 w-4" />
          ) : (
            <Info className="h-4 w-4" />
          )}
        </div>
        <div className="app-toast-copy">
          <span className="app-toast-title">{globalToast.title}</span>
          {globalToast.description ? (
            <span className="app-toast-description">{globalToast.description}</span>
          ) : null}
        </div>
        <button
          type="button"
          className="app-toast-close"
          onClick={dismissGlobalToast}
          aria-label={language === "vi" ? "Dong thong bao" : "Dismiss notification"}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  ) : null;

  if (showStartupShell) {
    return (
      <div className="app-root startup-shell-active">
        {connectionFormIntent && (
            <ConnectionForm
              initialIntent={connectionFormIntent}
              embeddedInStartupShell
              onClose={handleCloseConnectionForm}
            />
        )}

        {showStartupConnectionManager && !isConnected && !isConnecting && !connectionFormIntent && (
          <StartupConnectionManager
            onNewConnection={() => handleOpenConnectionForm("connect")}
            onOpenDatabaseFile={handleOpenDatabaseFile}
            windowControls={
              <div className="titlebar-window-controls startup-window-controls" data-no-window-drag="true">
                <button
                  type="button"
                  onClick={handleMinimizeWindow}
                  className="titlebar-window-btn"
                  title={t("titlebar.minimize")}
                  aria-label={t("titlebar.minimize")}
                >
                  <Minus className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={handleToggleMaximizeWindow}
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
                <button
                  type="button"
                  onClick={handleCloseWindow}
                  className="titlebar-window-btn danger"
                  title={t("titlebar.close")}
                  aria-label={t("titlebar.close")}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            }
          />
        )}
        {globalToastMarkup}
      </div>
    );
  }

  return (
    <div
      className={`app-root ${isWindowMaximized ? "window-maximized" : ""} ${showAISlidePanel ? "workspace-ai-open" : ""}`}
    >
      <AppTitleBar
        titlebarContextTitle={titlebarContextTitle}
        titlebarContextLabel={titlebarContextLabel}
        isConnected={isConnected}
        activeConn={activeConn}
        isWindowMaximized={isWindowMaximized}
        isWindowFocused={isWindowFocused}
        isWindowMenuOpen={isWindowMenuOpen}
        activeWindowMenuSection={activeWindowMenuSection}
        activeWindowMenuItemPath={activeWindowMenuItemPath}
        windowMenuRef={windowMenuRef}
        windowMenuSections={windowMenuSections}
        onToggleSidebar={handleToggleSidebar}
        onOpenAISettings={() => setShowAISettings(true)}
        onToggleMaximizeWindow={handleToggleMaximizeWindow}
        onMinimizeWindow={handleMinimizeWindow}
        onCloseWindow={handleCloseWindow}
        onToggleWindowMenu={handleToggleWindowMenu}
        onSetActiveWindowMenuSection={setActiveWindowMenuSection}
        onSetActiveWindowMenuItemPath={setActiveWindowMenuItemPath}
        isDesktopWindow={isDesktopWindow}
        t={t}
      />

      <ErrorBoundary>
        <Suspense fallback={<WorkspaceBootFallback />}>
          <AppWorkspacePanel
            tabs={tabs}
            activeTab={activeTab}
            isConnected={isConnected}
            isConnecting={isConnecting}
            isSidebarCollapsed={isSidebarCollapsed}
            sidebarWidth={sidebarWidth}
            leftPanel={leftPanel}
            isMetricsWorkspace={isMetricsWorkspace}
            activeConn={activeConn}
            currentDatabase={currentDatabase}
            activeDatabaseLabel={activeDatabaseLabel}
            activeQueryChrome={activeQueryChrome}
            activeWorkspaceActivity={activeWorkspaceActivity}
            querySessionByTab={querySessionByTab}
            queryRunRequestByTab={queryRunRequestByTab}
            error={error}
            onClearError={clearError}
            onNewQuery={handleNewQuery}
            onClearVisibleTabs={handleClearVisibleTabs}
            onRefreshWorkspace={handleRefreshWorkspace}
            onExportDatabase={handleExportDatabase}
            onOpenMetricsBoard={handleOpenMetricsBoard}
            onFocusExplorerSearch={handleFocusExplorerSearch}
            onOpenAISlidePanel={handleOpenAISlidePanel}
            onHandleShowDatabaseWorkspace={handleShowDatabaseWorkspace}
            onHandleQueryChromeChange={handleQueryChromeChange}
            onHandleQuerySessionChange={handleQuerySessionChange}
            onRunActiveQuery={handleRunActiveQuery}
            showTerminalPanel={showTerminalPanel}
            isExportingDatabase={isExportingDatabase}
            onToggleTerminalPanel={handleToggleTerminalPanel}
            onToggleSidebar={handleToggleSidebar}
            onSetConnectionFormIntent={setConnectionFormIntent}
            onHandleMouseDown={handleMouseDown}
          />
        </Suspense>
      </ErrorBoundary>

      <AppKeyboardHandler
        activeTab={activeTab}
        onNewQuery={handleNewQuery}
        onRunActiveQuery={handleRunActiveQuery}
        onToggleTerminalPanel={handleToggleTerminalPanel}
        onToggleSidebar={handleToggleSidebar}
        onToggleQueryHistory={handleToggleQueryHistory}
        onToggleSQLFavorites={handleToggleSQLFavorites}
        onToggleVimMode={toggleVimMode}
        onOpenCommandPalette={openCommandPalette}
        onOpenQuickSwitcher={openQuickSwitcher}
        setUiFontScale={setUiFontScale}
        setShowAISlidePanel={setShowAISlidePanel}
      />

      {connectionFormIntent && (
          <ConnectionForm
            initialIntent={connectionFormIntent}
            embeddedInStartupShell={false}
            onClose={handleCloseConnectionForm}
          />
      )}
      {showAISettings && (
        <Suspense fallback={null}>
          <AISettingsModal onClose={() => setShowAISettings(false)} />
        </Suspense>
      )}
      {showAboutModal && (
        <AppAboutModal onClose={() => setShowAboutModal(false)} />
      )}
      {showPluginManager && (
        <AppPluginManagerModal onClose={() => setShowPluginManager(false)} />
      )}
      {showKeyboardShortcutsModal && (
        <AppShortcutsModal onClose={() => setShowKeyboardShortcutsModal(false)} />
      )}
      {showThemeCustomizer && (
        <ThemeCustomizer onClose={() => setShowThemeCustomizer(false)} />
      )}
      <CommandPalette
        onToggleSidebar={handleToggleSidebar}
        onToggleTerminal={() => setShowTerminalPanel((v) => !v)}
        onRunQuery={handleRunActiveQuery}
        onFormatSQL={() => window.dispatchEvent(new CustomEvent("format-sql-palette"))}
        onFocusSQL={() => window.dispatchEvent(new CustomEvent("focus-sql-editor-palette"))}
        onFocusResults={() => window.dispatchEvent(new CustomEvent("focus-results-palette"))}
        onToggleQueryHistory={handleToggleQueryHistory}
        onToggleSQLFavorites={handleToggleSQLFavorites}
        onOpenKeyboardShortcuts={() => setShowKeyboardShortcutsModal(true)}
        onOpenPluginManager={() => setShowPluginManager(true)}
        onOpenSettings={handleOpenThemeCustomizer}
        onOpenAbout={() => setShowAboutModal(true)}
        onOpenSQLFile={() => window.dispatchEvent(new CustomEvent("open-sql-file-palette"))}
        onImportSQLFile={() => window.dispatchEvent(new CustomEvent("import-sql-file-palette"))}
        onClearAIHistory={() => window.dispatchEvent(new CustomEvent("clear-ai-history-palette"))}
        onToggleAISlidePanel={(open) => setShowAISlidePanel(open)}
      />
      <QuickSwitcher
        onOpenSavedQuery={(id) => {
          window.dispatchEvent(new CustomEvent("open-saved-query-switcher", { detail: { id } }));
        }}
        onConnect={(connectionId) => {
          window.dispatchEvent(new CustomEvent("connect-switcher", { detail: { connectionId } }));
        }}
      />
      {showStartupConnectionManager && !isConnected && !isConnecting && !connectionFormIntent && (
        <StartupConnectionManager
          onNewConnection={() => handleOpenConnectionForm("connect")}
          onOpenDatabaseFile={handleOpenDatabaseFile}
          windowControls={
            <div className="titlebar-window-controls startup-window-controls" data-no-window-drag="true">
              <button
                type="button"
                onClick={handleMinimizeWindow}
                className="titlebar-window-btn"
                title={t("titlebar.minimize")}
                aria-label={t("titlebar.minimize")}
              >
                <Minus className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={handleToggleMaximizeWindow}
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
              <button
                type="button"
                onClick={handleCloseWindow}
                className="titlebar-window-btn danger"
                title={t("titlebar.close")}
                aria-label={t("titlebar.close")}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          }
        />
      )}
      {(showAISlidePanel || hasMountedAISlidePanel) && (
        <Suspense fallback={null}>
          <ErrorBoundary onReset={() => setShowAISlidePanel(false)} fallback={null}>
            <AISlidePanel
              isOpen={showAISlidePanel}
              initialPrompt={aiPanelDraft?.prompt ?? ""}
              initialPromptNonce={aiPanelDraft?.nonce ?? 0}
              onClose={() => setShowAISlidePanel(false)}
            />
          </ErrorBoundary>
        </Suspense>
      )}
      <ErrorBoundary onReset={() => setShowQueryHistory(false)} fallback={null}>
        <QueryHistoryPanel
          isOpen={showQueryHistory}
          activeConnectionId={activeConnectionId}
          onClose={() => setShowQueryHistory(false)}
          onRunQuery={handleRunQueryFromHistory}
        />
      </ErrorBoundary>
      <SQLFavoritesPanel
        isOpen={showSQLFavorites}
        onClose={() => setShowSQLFavorites(false)}
        onRunQuery={handleRunQueryFromFavorites}
        currentEditorSql={activeTab?.type === "query" ? activeTab.content : ""}
      />
      <RowInspector
        isOpen={showRowInspector}
        data={rowInspectorData}
        onClose={handleRowInspectorClose}
        onEditCell={(columnName, value) => {
          if (rowInspectorData?.tableName && activeConnectionId) {
            void EventCenter.emit("row-inspector-edit-cell", { columnName, value });
          }
        }}
      />
      <SafeModeConfirmDialog />
      {showConnectionExporter && (
        <ConnectionExporter
          connections={connections}
          onClose={() => setShowConnectionExporter(false)}
        />
      )}
      {showConnectionImporter && (
        <ConnectionImporter
          onImport={(_imported) => {
            void useAppStore.getState().loadSavedConnections();
          }}
          onClose={() => setShowConnectionImporter(false)}
        />
      )}
      {globalToastMarkup}
    </div>
  );
}

export default App;
