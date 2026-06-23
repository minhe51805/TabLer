import {
  useState,
  useEffect,
  useEffectEvent,
  useRef,
  useCallback,
  useMemo,
  lazy,
  Suspense,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  CheckCircle2,
  Copy,
  Info,
  Minus,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "./stores/appStore";
import { EventCenter } from "./stores/event-center";
import { getLastPathSegment } from "./utils/path-utils";
import { ThemeEngine, useTheme } from "./stores/useTheme";
import { useEditorPreferencesStore } from "./stores/editorPreferencesStore";
import { useI18n, type AppLanguagePreference } from "./i18n";
import { StartupConnectionManager } from "./components/StartupConnectionManager";

import { AppTitleBar } from "./components/AppTitleBar";
import { AppKeyboardHandler } from "./components/AppKeyboardHandler";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useCommandPaletteStore } from "./stores/commandPaletteStore";
import { useQuickSwitcherStore } from "./stores/quickSwitcherStore";
import { getAdminQueryPreset, type AdminQueryKind } from "./utils/admin-query-presets";
import { APP_TOAST_EVENT, type AppToastPayload, emitAppToast } from "./utils/app-toast";
import { invokeMutation } from "./utils/tauri-utils";
import { getNewQueryTabTitle, getQueryProfile } from "./utils/query-profile";
import { buildDatabaseFileConnection, type DatabaseFileSelection } from "./utils/database-file";
import type {
  AIMetricsSchemaTableHint,
  OpenAIMetricsBoardCompletionDetail,
  OpenAIMetricsBoardDetail,
} from "./utils/metrics-board-templates";
import { splitSqlStatements } from "./utils/sqlStatements";
import { UI_FONT_SCALE_MAX, UI_FONT_SCALE_MIN, UI_FONT_SCALE_STEP } from "./utils/ui-scale";
import { useConnectionHealthMonitor } from "./hooks/useConnectionHealthMonitor";
import { useDeepLink } from "./hooks/useDeepLink";
import { useWindowMenu } from "./hooks/useWindowMenu";
import "./index.css";
import "./App.css";

import {
  QueryChromeState,
  WorkspaceActivityState,
  GlobalToastState,
  type WindowMenuSectionKey,
  GLOBAL_ERROR_AUTO_DISMISS_MS,
  GLOBAL_TOAST_AUTO_DISMISS_MS,
  GLOBAL_TOAST_EXIT_MS,
  RECOVERABLE_CONNECTION_ERROR_DELAY_MS,
  UI_FONT_SCALE_STORAGE_KEY,
  DEFAULT_WINDOW_MENU_SECTION,
  RECOVERABLE_CONNECTION_ERROR_PATTERNS,
} from "./types/app-types";

export interface QueryEditorSessionState extends QueryEditorSessionStateBase {}
import type { QueryEditorSessionState as QueryEditorSessionStateBase } from "./components/SQLEditor";

interface OpenAIWorkspaceQueryDetail {
  sql?: string;
  connectionId?: string;
  database?: string;
  title?: string;
  resultViewMode?: "table" | "chart";
  autoRun?: boolean;
  focusWorkspace?: boolean;
}

function yieldToBrowserFrame() {
  return new Promise<void>((resolve) => {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        window.setTimeout(resolve, 0);
      });
      return;
    }

    setTimeout(resolve, 0);
  });
}

const AISlidePanel = lazy(() => import("./components/AISlidePanel/AISlidePanel").then((module) => ({ default: module.AISlidePanel })));
const ConnectionForm = lazy(() =>
  import("./components/ConnectionForm").then((module) => ({ default: module.ConnectionForm })),
);
const AppGlobalModals = lazy(() =>
  import("./components/layout/AppGlobalModals").then((module) => ({ default: module.AppGlobalModals })),
);
const AppWorkspacePanel = lazy(() =>
  import("./components/AppWorkspacePanel").then((module) => ({ default: module.AppWorkspacePanel })),
);
const QueryHistoryPanel = lazy(() =>
  import("./components/QueryHistory/QueryHistoryPanel").then((module) => ({ default: module.QueryHistoryPanel })),
);
const SQLFavoritesPanel = lazy(() =>
  import("./components/SQLFavorites/SQLFavoritesPanel").then((module) => ({ default: module.SQLFavoritesPanel })),
);
const RowInspector = lazy(() =>
  import("./components/RowInspector/RowInspector").then((module) => ({ default: module.RowInspector })),
);

function loadTabPersistenceModule() {
  return import("./utils/tab-persistence");
}

function isRecoverableConnectionError(error: string | null) {
  if (!error) return false;
  return RECOVERABLE_CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

import { WorkspaceBootFallback } from "./components/layout/WorkspaceBootFallback";
import { WorkspaceErrorFallback } from "./components/layout/WorkspaceErrorFallback";
import { useModalStore } from "./stores/modalStore";
import { useAppLayoutStore } from "./stores/appLayoutStore";

function App() {
  useConnectionHealthMonitor();
  const { language, languagePreference, setLanguage, t } = useI18n();
  const { theme: _activeTheme, activateTheme } = useTheme();
  const {
    activeConnectionId,
    connectedIds,
    connections,
    tabs,
    activeTabId,
    currentDatabase,
    isConnecting,
    connectionHealth,
    error,
    clearError,
    setError,
    loadSavedConnections,
    addTab,
    setActiveTab,
    updateTab,
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
      connectionHealth: state.connectionHealth,
      error: state.error,
      clearError: state.clearError,
      setError: state.setError,
      loadSavedConnections: state.loadSavedConnections,
      addTab: state.addTab,
      setActiveTab: state.setActiveTab,
      updateTab: state.updateTab,
      fetchDatabases: state.fetchDatabases,
      fetchTables: state.fetchTables,
      fetchSchemaObjects: state.fetchSchemaObjects,
    }))
  );

  const {
    connectionFormIntent, setConnectionFormIntent,
    showStartupConnectionManager, setShowStartupConnectionManager,
    showAISettings, setShowAISettings,
    showAboutModal, setShowAboutModal,
    showPluginManager, setShowPluginManager,
    showKeyboardShortcutsModal, setShowKeyboardShortcutsModal,
    showThemeCustomizer, setShowThemeCustomizer,
    showConnectionExporter, setShowConnectionExporter,
    showConnectionImporter, setShowConnectionImporter
  } = useModalStore();

  const {
    showTerminalPanel, setShowTerminalPanel,
    showQueryHistory, setShowQueryHistory,
    showSQLFavorites, setShowSQLFavorites,
    showRowInspector, setShowRowInspector,
    rowInspectorData, setRowInspectorData,
    leftPanel, setLeftPanel,
    isSidebarCollapsed, setIsSidebarCollapsed,
    sidebarWidth, setSidebarWidth,
    isWindowMaximized, setIsWindowMaximized,
    isWindowFocused, setIsWindowFocused,
    forceLauncherVisible, setForceLauncherVisible
  } = useAppLayoutStore();

  const [showAISlidePanel, setShowAISlidePanel] = useState(false);
  const [hasMountedAISlidePanel, setHasMountedAISlidePanel] = useState(false);
  const [hasMountedGlobalModals, setHasMountedGlobalModals] = useState(false);
  const [isExportingDatabase, setIsExportingDatabase] = useState(false);
  const [aiPanelDraft, setAiPanelDraft] = useState<{ prompt: string; nonce: number } | null>(null);
  const [aiPanelAttachment, setAiPanelAttachment] = useState<{ text: string; source: string; boardId?: string; nonce: number } | null>(null);
  const [queryChromeByTab, setQueryChromeByTab] = useState<Record<string, QueryChromeState>>({});
  const [querySessionByTab, setQuerySessionByTab] = useState<Record<string, QueryEditorSessionState>>({});
  const [queryRunRequestByTab, setQueryRunRequestByTab] = useState<Record<string, number>>({});
  const [workspaceActivityByConnection, setWorkspaceActivityByConnection] = useState<
    Record<string, WorkspaceActivityState>
  >({});
  const [globalToast, setGlobalToast] = useState<GlobalToastState | null>(null);
  const [isRecoverableErrorDelayActive, setIsRecoverableErrorDelayActive] = useState(false);
  const [isWindowMenuOpen, setIsWindowMenuOpen] = useState(false);
  const [activeWindowMenuSection, setActiveWindowMenuSection] =
    useState<WindowMenuSectionKey | null>(null);
  const [activeWindowMenuItemPath, setActiveWindowMenuItemPath] = useState<string | null>(null);
  const [uiFontScale, setUiFontScale] = useState(() => {
    if (typeof window === "undefined") return 100;
    const stored = Number(window.localStorage.getItem(UI_FONT_SCALE_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= UI_FONT_SCALE_MIN && stored <= UI_FONT_SCALE_MAX ? stored : 100;
  });
  const toggleVimMode = useEditorPreferencesStore((state) => state.toggleVimMode);
  const openCommandPalette = useCommandPaletteStore((state) => state.open);
  const isCommandPaletteOpen = useCommandPaletteStore((state) => state.isOpen);
  const openQuickSwitcher = useQuickSwitcherStore((state) => state.open);
  const isQuickSwitcherOpen = useQuickSwitcherStore((state) => state.isOpen);

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
  const shouldMountGlobalModalsNow =
    showAISettings ||
    showAboutModal ||
    showPluginManager ||
    showKeyboardShortcutsModal ||
    showThemeCustomizer ||
    showConnectionExporter ||
    showConnectionImporter ||
    isCommandPaletteOpen ||
    isQuickSwitcherOpen;
  const shouldRenderGlobalModals = hasMountedGlobalModals || shouldMountGlobalModalsNow;
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
  
      setActiveWindowMenuSection(null);
  
      setForceLauncherVisible(true);
      setIsRecoverableErrorDelayActive(false);
      recoveredConnectionErrorRef.current = null;
      recoverableConnectionErrorTimeoutRef.current = null;
      clearError();
      void applyDesktopWindowProfile("launcher").catch((e) =>
        console.error("[WindowProfile] failed to apply launcher profile:", e),
      );
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
      void applyDesktopWindowProfile("form").catch((e) =>
        console.error("[WindowProfile] failed to apply form profile:", e),
      );
    },
    [applyDesktopWindowProfile],
  );

  const handleCloseConnectionForm = useCallback(() => {
    const { activeConnectionId: latestActiveConnectionId, connectedIds: latestConnectedIds } =
      useAppStore.getState();

    setConnectionFormIntent(null);
    if (!latestActiveConnectionId || !latestConnectedIds.has(latestActiveConnectionId)) {
      setShowStartupConnectionManager(true);
      void applyDesktopWindowProfile("launcher").catch((e) =>
        console.error("[WindowProfile] failed to apply launcher profile:", e),
      );
    }
  }, [applyDesktopWindowProfile]);

  const handleGoToLauncher = useCallback(() => {
    const currentState = useAppStore.getState();
    const nextConnectedIds = new Set(currentState.connectedIds);
    if (currentState.activeConnectionId) {
      nextConnectedIds.delete(currentState.activeConnectionId);
    }

    useAppStore.setState({
      activeConnectionId: null,
      connectedIds: nextConnectedIds,
      currentDatabase: null,
      databases: [],
      tables: [],
      schemaObjects: [],
      isConnecting: false,
      error: null,
    });

    setShowStartupConnectionManager(true);
    setConnectionFormIntent(null);
    setShowAISlidePanel(false);
    setShowTerminalPanel(false);
    setShowQueryHistory(false);
    setShowSQLFavorites(false);
    setShowRowInspector(false);
    setRowInspectorData(null);
    setForceLauncherVisible(true);
    setIsWindowMenuOpen(false);
    setActiveWindowMenuSection(null);
    setActiveWindowMenuItemPath(null);
    clearError();

    void applyDesktopWindowProfile("launcher").catch((e) =>
      console.error("[WindowProfile] failed to apply launcher profile:", e),
    );
  }, [
    applyDesktopWindowProfile,
    clearError,
    setConnectionFormIntent,
    setForceLauncherVisible,
    setRowInspectorData,
    setShowAISlidePanel,
    setShowQueryHistory,
    setShowRowInspector,
    setShowSQLFavorites,
    setShowStartupConnectionManager,
    setShowTerminalPanel,
  ]);

  const handleToggleWindowMenu = useCallback((event?: ReactMouseEvent<HTMLElement>) => {
    event?.stopPropagation();
    setIsWindowMenuOpen((current) => {
      const next = !current;
      if (next) {
        setActiveWindowMenuSection(DEFAULT_WINDOW_MENU_SECTION);
    
      }
      return next;
    });
  }, []);

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

  const handleChangeLanguage = useCallback(
    (nextLanguage: AppLanguagePreference) => {
      setLanguage(nextLanguage);
    },
    [setLanguage],
  );

  const handleSetFontSizeFromMenu = useCallback((next: number) => {
    const normalized = Math.min(
      UI_FONT_SCALE_MAX,
      Math.max(UI_FONT_SCALE_MIN, Math.round(next / UI_FONT_SCALE_STEP) * UI_FONT_SCALE_STEP),
    );
    setUiFontScale(normalized);
  }, []);

  const handleIncreaseFontSizeInline = useCallback(() => {
    setUiFontScale((current) => Math.min(UI_FONT_SCALE_MAX, current + UI_FONT_SCALE_STEP));
  }, []);

  const handleDecreaseFontSizeInline = useCallback(() => {
    setUiFontScale((current) => Math.max(UI_FONT_SCALE_MIN, current - UI_FONT_SCALE_STEP));
  }, []);

  const handleToggleTerminalPanel = useCallback(() => {
    setShowTerminalPanel((current) => !current);
  }, []);

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

  const handleSearchInDatabaseFromMenu = useCallback(() => {
    handleShowDatabaseWorkspace();
    window.setTimeout(() => {
      handleFocusExplorerSearch();
    }, 0);
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
        current?.showResultsPane === state.showResultsPane &&
        current?.resultViewMode === state.resultViewMode &&
        current?.explainPlan === state.explainPlan
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
    if (hasMountedGlobalModals) return;
    if (shouldMountGlobalModalsNow) {
      setHasMountedGlobalModals(true);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setHasMountedGlobalModals(true);
    }, 1200);

    return () => window.clearTimeout(timeoutId);
  }, [hasMountedGlobalModals, shouldMountGlobalModalsNow]);

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

  const handleOpenAIWorkspaceQuery = useCallback((detail: OpenAIWorkspaceQueryDetail) => {
    const sql = detail.sql?.trim();
    const targetConnectionId = detail.connectionId || activeConnectionId;
    if (!sql || !targetConnectionId) return;

    const resultViewMode = detail.resultViewMode ?? "table";
    const shouldShowResultsPane = resultViewMode === "chart" || Boolean(detail.autoRun);
    const tabId = `query-${crypto.randomUUID()}`;

    addTab({
      id: tabId,
      type: "query",
      title: detail.title?.trim() || (resultViewMode === "chart" ? "AI Chart" : "AI Query"),
      connectionId: targetConnectionId,
      database: detail.database || currentDatabase || undefined,
      content: sql,
    });

    setQuerySessionByTab((prev) => ({
      ...prev,
      [tabId]: {
        result: null,
        error: null,
        notice: null,
        queryCount: 0,
        editorHeight: 42,
        showResultsPane: shouldShowResultsPane,
        resultViewMode,
      },
    }));

    if (detail.autoRun) {
      setQueryRunRequestByTab((prev) => ({
        ...prev,
        [tabId]: (prev[tabId] ?? 0) + 1,
      }));
    }

  }, [activeConnectionId, addTab, currentDatabase]);

  const handleOpenAIMetricsBoard = useCallback(async (detail: OpenAIMetricsBoardDetail) => {
    const dispatchMetricsBoardCompletion = (payload: OpenAIMetricsBoardCompletionDetail) => {
      if (!detail.requestId) return;
      window.dispatchEvent(
        new CustomEvent("open-ai-metrics-board-complete", {
          detail: {
            requestId: detail.requestId,
            ...payload,
          },
        }),
      );
    };

    const targetConnectionId = detail.connectionId || activeConnectionId;
    const targetDatabase = detail.database || currentDatabase || undefined;
    if (!targetConnectionId) {
      dispatchMetricsBoardCompletion({
        success: false,
        error: "Missing target connection",
      });
      return;
    }

    const targetConnection = connections.find((connection) => connection.id === targetConnectionId);
    if (!targetConnection) {
      dispatchMetricsBoardCompletion({
        success: false,
        error: "Target connection not found",
      });
      return;
    }

    try {
      const [
        metricsStorageModule,
        metricsTemplateModule,
      ] = await Promise.all([
        import("./components/MetricsBoard/utils/query-builder"),
        import("./utils/metrics-board-templates"),
      ]);

      const collectMetricsSchemaHints = async (): Promise<AIMetricsSchemaTableHint[]> => {
        const appState = useAppStore.getState();
        const activeStoreConnectionId = appState.activeConnectionId;
        const activeStoreDatabase = appState.currentDatabase || undefined;

        if (targetConnectionId !== activeStoreConnectionId || (targetDatabase || "") !== (activeStoreDatabase || "")) {
          return [];
        }

        let latestTables = appState.tables ?? [];
        if (latestTables.length === 0 && targetDatabase) {
          await appState.fetchTables(targetConnectionId, targetDatabase);
          latestTables = useAppStore.getState().tables ?? [];
        }

        if (latestTables.length === 0) {
          return [];
        }

        const normalizeTableName = (value: string) =>
          value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "");

        const businessPriority = [
          "users",
          "sessions",
          "refresh_tokens",
          "oauth_client",
          "oauth_clients",
          "oauth_authorizations",
          "oauth_consents",
          "identities",
          "audit_log_entries",
          "audit_logs",
          "user_logs",
          "smart_alerts",
          "messages",
          "products",
          "categories",
          "brands",
          "coupons",
          "orders",
          "order_items",
          "reviews",
          "workspaces",
          "buckets",
          "objects",
          "job_post",
          "job_posts",
          "job_application",
          "job_applications",
          "organization",
          "organizations",
          "organization_type",
          "organization_types",
          "industry",
          "industries",
          "province",
          "provinces",
          "country",
          "countries",
          "interview_schedule",
          "interview_schedules",
          "interview_feedback",
          "interview_feedbacks",
          "interview_participants",
        ];

        const prioritizedTables = [...latestTables]
          .sort((left, right) => {
            const leftPriority = businessPriority.indexOf(normalizeTableName(left.name));
            const rightPriority = businessPriority.indexOf(normalizeTableName(right.name));
            if (leftPriority !== rightPriority) {
              return (leftPriority === -1 ? Number.MAX_SAFE_INTEGER : leftPriority) -
                (rightPriority === -1 ? Number.MAX_SAFE_INTEGER : rightPriority);
            }

            const leftRowCount = left.row_count ?? -1;
            const rightRowCount = right.row_count ?? -1;
            if (leftRowCount !== rightRowCount) {
              return rightRowCount - leftRowCount;
            }

            return left.name.localeCompare(right.name);
          })
          .filter((table, index, collection) =>
            collection.findIndex((candidate) => normalizeTableName(candidate.name) === normalizeTableName(table.name)) === index
          )
          .slice(0, 18);

        const schemaHints: AIMetricsSchemaTableHint[] = [];
        const batchSize = 4;

        for (let index = 0; index < prioritizedTables.length; index += batchSize) {
          const batch = prioritizedTables.slice(index, index + batchSize);
          const batchResults = await Promise.all(
            batch.map(async (table) => {
              try {
                const structure = await appState.getTableStructure(targetConnectionId, table.name, targetDatabase);
                return {
                  name: table.name,
                  schema: table.schema,
                  rowCount: table.row_count ?? null,
                  columns: structure.columns.map((column) => column.name),
                } satisfies AIMetricsSchemaTableHint;
              } catch {
                return {
                  name: table.name,
                  schema: table.schema,
                  rowCount: table.row_count ?? null,
                  columns: [],
                } satisfies AIMetricsSchemaTableHint;
              }
            }),
          );

          schemaHints.push(...batchResults);
          await yieldToBrowserFrame();
        }

        return schemaHints;
      };

      const needsSchemaHints =
        detail.mode !== "edit" &&
        (detail.template ?? "database-overview") === "database-overview";
      const schemaHints = needsSchemaHints ? await collectMetricsSchemaHints() : [];

      const allBoards = metricsStorageModule.readStoredBoards();
      const connectionBoards = allBoards.filter((board) => board.connection_id === targetConnectionId);
      const existingMetricsTab =
        tabs.find(
          (tab) =>
            tab.type === "metrics" &&
            tab.connectionId === targetConnectionId &&
            (tab.database || "") === (targetDatabase || ""),
        ) || null;
      const targetBoardId =
        detail.boardId ||
        ((detail.mode === "augment" || detail.mode === "rebuild" || detail.mode === "edit")
          ? activeTab?.metricsBoardId || existingMetricsTab?.metricsBoardId
          : undefined);

      const targetBoard =
        (targetBoardId && connectionBoards.find((board) => board.id === targetBoardId)) || null;

      let nextBoard: (typeof targetBoard) | null = null;
      let nextAllBoards = allBoards;
      let didChange = false;
      let created = false;
      let addedCount = 0;
      let addedTitles: string[] = [];
      let addedWidgetIds: string[] = [];

      if (detail.mode === "edit" && targetBoard && detail.editTargetTitle) {
        const normalizeWidgetTitle = (value: string) =>
          value
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .trim();

        const normalizedTargetTitle = normalizeWidgetTitle(detail.editTargetTitle);
        const targetWidget =
          targetBoard.widgets.find((widget) => normalizeWidgetTitle(widget.title) === normalizedTargetTitle) ||
          targetBoard.widgets.find((widget) => normalizeWidgetTitle(widget.title).includes(normalizedTargetTitle)) ||
          targetBoard.widgets.find((widget) => normalizedTargetTitle.includes(normalizeWidgetTitle(widget.title))) ||
          null;

        if (targetWidget) {
          const nextType = detail.editTargetType || targetWidget.type;
          const nextWidgetLibraryItem = metricsStorageModule.getWidgetLibraryItem(nextType);
          const nextWidget = {
            ...targetWidget,
            type: nextType,
            title: detail.editTitle?.trim() || targetWidget.title,
            query: detail.editQuery?.trim() || targetWidget.query,
            col_span: nextType === targetWidget.type ? targetWidget.col_span : Math.max(targetWidget.col_span, nextWidgetLibraryItem.colSpan),
            row_span: nextType === targetWidget.type ? targetWidget.row_span : Math.max(targetWidget.row_span, nextWidgetLibraryItem.rowSpan),
          };

          const widgetChanged =
            nextWidget.type !== targetWidget.type ||
            nextWidget.title !== targetWidget.title ||
            nextWidget.query !== targetWidget.query ||
            nextWidget.col_span !== targetWidget.col_span ||
            nextWidget.row_span !== targetWidget.row_span;

          nextBoard = widgetChanged
            ? {
                ...targetBoard,
                widgets: targetBoard.widgets.map((widget) => (widget.id === targetWidget.id ? nextWidget : widget)),
                updated_at: Date.now(),
              }
            : targetBoard;
          nextAllBoards = widgetChanged
            ? allBoards.map((board) => (board.id === targetBoard.id ? nextBoard! : board))
            : allBoards;
          didChange = widgetChanged;
          addedCount = widgetChanged ? 1 : 0;
          addedTitles = [nextWidget.title];
          addedWidgetIds = [nextWidget.id];
        }
      }

      if (detail.mode === "edit") {
        if (!targetBoard) {
          dispatchMetricsBoardCompletion({
            success: false,
            error: "Target dashboard not found",
          });
          return;
        }
        if (!nextBoard) {
          nextBoard = targetBoard;
        }
      }

      if (!nextBoard && (detail.mode === "augment" || detail.mode === "rebuild") && targetBoard) {
        const updatedBoardResult = detail.mode === "rebuild"
          ? metricsTemplateModule.rebuildAIMetricsBoardDefinition({
              board: targetBoard,
              detail: {
                ...detail,
                database: targetDatabase,
              },
              dbType: targetConnection.db_type,
              schemaHints,
            })
          : metricsTemplateModule.augmentAIMetricsBoardDefinition({
              board: targetBoard,
              detail: {
                ...detail,
                database: targetDatabase,
              },
              dbType: targetConnection.db_type,
              schemaHints,
            });

        if (updatedBoardResult) {
          nextBoard = updatedBoardResult.board;
          addedCount = updatedBoardResult.addedCount;
          addedTitles = updatedBoardResult.addedTitles;
          addedWidgetIds = updatedBoardResult.addedWidgetIds;
          const renamed = updatedBoardResult.board.name.trim() !== targetBoard.name.trim();
          didChange = detail.mode === "rebuild" ? true : addedCount > 0 || renamed;
          if (didChange) {
            nextAllBoards = allBoards.map((board) => (board.id === updatedBoardResult.board.id ? updatedBoardResult.board : board));
          } else {
            nextBoard = targetBoard;
          }
        }
      }

      // Agent-designed widgets take priority: build the board straight from the
      // concrete chart/table specs the AI produced instead of a fixed template.
      if (!nextBoard && Array.isArray(detail.aiWidgets) && detail.aiWidgets.length > 0) {
        const aiBoard = metricsTemplateModule.createAIMetricsBoardFromWidgets({
          widgets: detail.aiWidgets,
          title: detail.title,
          database: targetDatabase,
          connectionId: targetConnectionId,
          existingBoards: connectionBoards,
        });
        if (aiBoard) {
          nextBoard = aiBoard;
          nextAllBoards = [...allBoards, aiBoard];
          didChange = true;
          created = true;
          addedCount = aiBoard.widgets.length;
          addedTitles = aiBoard.widgets.map((widget) => widget.title);
          addedWidgetIds = aiBoard.widgets.map((widget) => widget.id);
        }
      }

      if (!nextBoard) {
        nextBoard = metricsTemplateModule.createAIMetricsBoardDefinition({
          detail: {
            ...detail,
            database: targetDatabase,
          },
          dbType: targetConnection.db_type,
          connectionId: targetConnectionId,
          existingBoards: connectionBoards,
          schemaHints,
        });
        if (nextBoard) {
          nextAllBoards = [...allBoards, nextBoard];
          didChange = true;
          created = true;
        }
      }

      if (!nextBoard) {
        emitAppToast({
          tone: "info",
          title: language === "vi" ? "Dashboard chua ho tro cho engine nay" : "Dashboard template is not available here",
          description:
            language === "vi"
              ? "TableR chua co san dashboard overview da widget cho engine database hien tai."
              : "TableR does not have a built-in multi-chart overview dashboard for the current database engine yet.",
        });
        dispatchMetricsBoardCompletion({
          success: false,
          error: "Dashboard template is not available for the current database engine",
        });
        return;
      }

      if (didChange) {
        metricsStorageModule.writeStoredBoards(nextAllBoards);
        window.dispatchEvent(
          new CustomEvent("metrics-boards-updated", {
            detail: { connectionId: targetConnectionId },
          }),
        );
      }

      setLeftPanel("metrics");

      if (existingMetricsTab) {
        updateTab(existingMetricsTab.id, {
          metricsBoardId: nextBoard.id,
          title: nextBoard.name,
          database: nextBoard.database,
        });
        setActiveTab(existingMetricsTab.id);
      } else {
        addTab({
          id: `metrics-${crypto.randomUUID()}`,
          type: "metrics",
          title: nextBoard.name,
          connectionId: targetConnectionId,
          database: nextBoard.database,
          metricsBoardId: nextBoard.id,
        });
      }

      dispatchMetricsBoardCompletion({
        success: true,
        boardId: nextBoard.id,
        didChange,
        addedCount,
        addedTitles,
        addedWidgetIds,
        created,
      });

      if (didChange && addedWidgetIds.length > 0) {
        const focusTargetBoardId = nextBoard.id;
        const focusTargetWidgetId = addedWidgetIds[0];
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("focus-metrics-widget", {
              detail: {
                boardId: focusTargetBoardId,
                widgetId: focusTargetWidgetId,
              },
            }),
          );
        }, 60);
      }
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      setError(
        language === "vi"
          ? `Khong the mo dashboard AI: ${message}`
          : `Could not open the AI dashboard: ${message}`,
      );
      dispatchMetricsBoardCompletion({
        success: false,
        error: message,
      });
    }
  }, [
    activeConnectionId,
    addTab,
    connections,
    currentDatabase,
    language,
    activeTab?.metricsBoardId,
    setActiveTab,
    setError,
    setLeftPanel,
    tabs,
    updateTab,
  ]);

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
  
  
    },
    [activeConn, activeConnectionId, addTab, currentDatabase, language, setError, t],
  );

  const handleOpenAISlidePanel = useCallback((prompt?: string, attachment?: { text: string; source: string; boardId?: string }) => {
    if (typeof prompt === "string" && prompt.trim()) {
      setAiPanelDraft({
        prompt,
        nonce: Date.now(),
      });
    }
    if (attachment?.text.trim()) {
      setAiPanelAttachment({
        text: attachment.text.trim(),
        source: attachment.source?.trim() || "Workspace attachment",
        boardId: attachment.boardId,
        nonce: Date.now(),
      });
    }
    setShowAISlidePanel(true);
  }, []);

  const handleActivateThemeFromMenu = useCallback(
    (themeId: string) => {
      const selectedTheme = ThemeEngine.getAvailableThemes().find((option) => option.id === themeId);
      if (!selectedTheme) return;
      activateTheme(selectedTheme);
    },
    [activateTheme],
  );

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

  const handleWindowMenuClose = useCallback(() => {
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, []);

  const menuActions = useMemo(() => ({
    onNewConnection: handleOpenConnectionForm.bind(null, "connect"),
    onOpenDatabaseFile: handleOpenDatabaseFile,
    onImportSqlFile: handleImportSqlFile,
    onImportSqlIntoCurrentDatabase: handleImportSqlIntoCurrentDatabase,
    onExportDatabase: handleExportDatabase,
    onOpenMetricsBoard: handleOpenMetricsBoard,
    onCloseWindow: handleCloseWindow,
    onNewQuery: handleNewQuery,
    onToggleSidebar: handleToggleSidebar,
    onToggleTerminalPanel: handleToggleTerminalPanel,
    onToggleQueryResultsPane: () => {
      if (activeTab?.type === "query") {
        window.dispatchEvent(new CustomEvent("toggle-query-results-pane", { detail: { tabId: activeTab.id } }));
      }
    },
    onToggleRightSidebar: () => setShowAISlidePanel((v) => !v),
    onToggleBottomSidebar: () => {
      if (activeTab?.type === "query") {
        window.dispatchEvent(new CustomEvent("toggle-query-results-pane", { detail: { tabId: activeTab.id } }));
      } else {
        setShowTerminalPanel((v) => !v);
      }
    },
    onFocusExplorerSearch: handleFocusExplorerSearch,
    onShowDatabaseWorkspace: handleShowDatabaseWorkspace,
    onRefreshWorkspace: handleRefreshWorkspace,
    onSearchInDatabase: handleSearchInDatabaseFromMenu,
    onSetFontSize: handleSetFontSizeFromMenu,
    onIncreaseFontSize: handleIncreaseFontSizeInline,
    onDecreaseFontSize: handleDecreaseFontSizeInline,
    onActivateTheme: handleActivateThemeFromMenu,
    onOpenUserManagement: () => handleOpenAdminQuery("user-management"),
    onOpenProcessList: () => handleOpenAdminQuery("process-list"),
    onOpenAISettings: () => setShowAISettings(true),
    onOpenAISlidePanel: () => handleOpenAISlidePanel(),
    onOpenPluginManager: () => setShowPluginManager(true),
    onOpenAboutModal: () => setShowAboutModal(true),
    onOpenKeyboardShortcuts: () => setShowKeyboardShortcutsModal(true),
    onToggleQueryHistory: () => setShowQueryHistory((v) => !v),
    onOpenConnectionExporter: () => setShowConnectionExporter(true),
    onOpenConnectionImporter: () => setShowConnectionImporter(true),
    onChangeLanguage: handleChangeLanguage,
    onWindowMenuClose: handleWindowMenuClose,
  }), [activeTab, handleActivateThemeFromMenu, handleChangeLanguage, handleCloseWindow, handleFocusExplorerSearch, handleIncreaseFontSizeInline, handleNewQuery, handleOpenAdminQuery, handleOpenAISlidePanel, handleOpenConnectionForm, handleOpenDatabaseFile, handleOpenMetricsBoard, handleRefreshWorkspace, handleSearchInDatabaseFromMenu, handleSetFontSizeFromMenu, handleToggleTerminalPanel, handleWindowMenuClose, handleImportSqlFile, handleImportSqlIntoCurrentDatabase, handleExportDatabase, handleToggleSidebar, handleShowDatabaseWorkspace, handleDecreaseFontSizeInline]);

  const { menuSections: windowMenuSections } = useWindowMenu({
    state: {
      isConnected,
      supportsSqlFileActions,
      activeTabType: activeTab?.type,
      uiFontScale,
      languagePreference,
      connectionsCount: connections.length,
    },
    actions: menuActions,
  });

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

  const persistTabs = useEffectEvent((connectionId: string, tabsToPersist: typeof tabs, nextActiveTabId: string | null) => {
    void loadTabPersistenceModule().then(({ saveTabState }) =>
      saveTabState(connectionId, tabsToPersist, nextActiveTabId),
    );
  });

  // Deep link handler: restore tabs after a successful connection
  useEffect(() => {
    if (!activeConnectionId || !connectedIds.has(activeConnectionId)) return;

    let cancelled = false;
    const restoreTabs = async () => {
      const { loadTabState } = await loadTabPersistenceModule();
      if (cancelled) return;

      const persisted = await loadTabState(activeConnectionId);
      if (cancelled || persisted.length === 0) return;

      const activePersistedTab = persisted.find((t) => t.isActive);
      const { addTab: addPersistedTab, setActiveTab: setPersistedActiveTab } = useAppStore.getState();

      for (const pt of persisted) {
        const newTabId = pt.tabId;
        // Check if tab already exists
        if (useAppStore.getState().tabs.some((t) => t.id === newTabId)) continue;

        if (pt.tabType === "query") {
          addPersistedTab({
            id: newTabId,
            type: pt.tabType,
            title: pt.title,
            connectionId: activeConnectionId,
            database: pt.database,
            content: pt.content,
          });
        } else if (pt.tabType === "table" && pt.tableName) {
          addPersistedTab({
            id: newTabId,
            type: pt.tabType,
            title: pt.title,
            connectionId: activeConnectionId,
            database: pt.database,
            tableName: pt.tableName,
          });
        } else if (pt.tabType === "structure" && pt.tableName) {
          addPersistedTab({
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
        setPersistedActiveTab(activePersistedTab.tabId);
      }
    };

    void restoreTabs();
    return () => { cancelled = true; };
  }, [activeConnectionId, connectedIds]);

  // Save tabs on connection when tabs change or app closes
  useEffect(() => {
    if (!activeConnectionId || !connectedIds.has(activeConnectionId)) return;

    persistTabs(activeConnectionId, tabs, activeTabId);
  }, [activeConnectionId, activeTabId, connectedIds, persistTabs, tabs]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      const state = useAppStore.getState();
      if (state.activeConnectionId && state.connectedIds.has(state.activeConnectionId)) {
        persistTabs(state.activeConnectionId, state.tabs, state.activeTabId);
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [persistTabs]);

  useDeepLink(isDesktopWindow, isConnected, handleOpenConnectionForm, setQueryRunRequestByTab);

  useEffect(() => {
    const handleOpenAI = (event: Event) => {
      const detail = (event as CustomEvent<{
        prompt?: string;
        attachment?: { text?: string; source?: string; boardId?: string };
      }>).detail;
      handleOpenAISlidePanel(
        detail?.prompt,
        detail?.attachment?.text
          ? {
              text: detail.attachment.text,
              source: detail.attachment.source || "Workspace attachment",
              boardId: detail.attachment.boardId,
            }
          : undefined,
      );
    };
    window.addEventListener("open-ai-slide-panel", handleOpenAI);
    return () => window.removeEventListener("open-ai-slide-panel", handleOpenAI);
  }, [handleOpenAISlidePanel]);

  useEffect(() => {
    const handleOpenAIWorkspaceQueryEvent = (event: Event) => {
      const detail = (event as CustomEvent<OpenAIWorkspaceQueryDetail>).detail;
      handleOpenAIWorkspaceQuery(detail ?? {});
    };
    window.addEventListener("open-ai-workspace-query", handleOpenAIWorkspaceQueryEvent);
    return () => window.removeEventListener("open-ai-workspace-query", handleOpenAIWorkspaceQueryEvent);
  }, [handleOpenAIWorkspaceQuery]);

  useEffect(() => {
    const handleOpenAIMetricsBoardEvent = (event: Event) => {
      const detail = (event as CustomEvent<OpenAIMetricsBoardDetail>).detail;
      void handleOpenAIMetricsBoard(detail ?? {});
    };
    window.addEventListener("open-ai-metrics-board", handleOpenAIMetricsBoardEvent);
    return () => window.removeEventListener("open-ai-metrics-board", handleOpenAIMetricsBoardEvent);
  }, [handleOpenAIMetricsBoard]);

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

    setActiveWindowMenuSection(null);

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
          <Suspense fallback={null}>
            <ConnectionForm
              initialIntent={connectionFormIntent}
              embeddedInStartupShell
              onClose={handleCloseConnectionForm}
            />
          </Suspense>
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
        isHealthy={activeConnectionId ? (connectionHealth[activeConnectionId] ?? true) : true}
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

      <ErrorBoundary
        maxRetries={2}
        onMaxRetriesExceeded={handleGoToLauncher}
        fallback={(error, reset) => (
          <WorkspaceErrorFallback
            error={error}
            onRetry={reset}
            onGoToLauncher={handleGoToLauncher}
          />
        )}
      >
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
            onGoToLauncher={handleGoToLauncher}
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
        <Suspense fallback={null}>
          <ConnectionForm
            initialIntent={connectionFormIntent}
            embeddedInStartupShell={false}
            onClose={handleCloseConnectionForm}
          />
        </Suspense>
      )}
      {shouldRenderGlobalModals && (
        <Suspense fallback={null}>
          <AppGlobalModals
            showAISettings={showAISettings}
            setShowAISettings={setShowAISettings}
            showAboutModal={showAboutModal}
            setShowAboutModal={setShowAboutModal}
            showPluginManager={showPluginManager}
            setShowPluginManager={setShowPluginManager}
            showKeyboardShortcutsModal={showKeyboardShortcutsModal}
            setShowKeyboardShortcutsModal={setShowKeyboardShortcutsModal}
            showThemeCustomizer={showThemeCustomizer}
            setShowThemeCustomizer={setShowThemeCustomizer}
            showConnectionExporter={showConnectionExporter}
            setShowConnectionExporter={setShowConnectionExporter}
            showConnectionImporter={showConnectionImporter}
            setShowConnectionImporter={setShowConnectionImporter}
            connections={connections}
            handleToggleSidebar={handleToggleSidebar}
            setShowTerminalPanel={setShowTerminalPanel}
            handleRunActiveQuery={handleRunActiveQuery}
            handleToggleQueryHistory={handleToggleQueryHistory}
            handleToggleSQLFavorites={handleToggleSQLFavorites}
            handleOpenThemeCustomizer={handleOpenThemeCustomizer}
            setShowAISlidePanel={setShowAISlidePanel}
          />
        </Suspense>
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
      {(showAISlidePanel || hasMountedAISlidePanel) && (
        <Suspense fallback={null}>
          <ErrorBoundary onReset={() => setShowAISlidePanel(false)} fallback={null}>
            <AISlidePanel
              isOpen={showAISlidePanel}
              initialPrompt={aiPanelDraft?.prompt ?? ""}
              initialPromptNonce={aiPanelDraft?.nonce ?? 0}
              initialAttachment={aiPanelAttachment ? {
                text: aiPanelAttachment.text,
                source: aiPanelAttachment.source,
                boardId: aiPanelAttachment.boardId,
              } : undefined}
              initialAttachmentNonce={aiPanelAttachment?.nonce ?? 0}
              onClose={() => setShowAISlidePanel(false)}
            />
          </ErrorBoundary>
        </Suspense>
      )}
      {showQueryHistory && (
        <Suspense fallback={null}>
          <ErrorBoundary onReset={() => setShowQueryHistory(false)} fallback={null}>
            <QueryHistoryPanel
              isOpen={showQueryHistory}
              activeConnectionId={activeConnectionId}
              onClose={() => setShowQueryHistory(false)}
              onRunQuery={handleRunQueryFromHistory}
            />
          </ErrorBoundary>
        </Suspense>
      )}
      {showSQLFavorites && (
        <Suspense fallback={null}>
          <SQLFavoritesPanel
            isOpen={showSQLFavorites}
            onClose={() => setShowSQLFavorites(false)}
            onRunQuery={handleRunQueryFromFavorites}
            currentEditorSql={activeTab?.type === "query" ? activeTab.content : ""}
          />
        </Suspense>
      )}
      {showRowInspector && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}
      {globalToastMarkup}
    </div>
  );
}

export default App;
