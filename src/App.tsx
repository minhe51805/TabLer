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
  AlertCircle,
  Cable,
  Copy,
  Database,
  FolderTree,
  Minus,
  PanelRightClose,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Square,
  Sparkles,
  X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "./stores/appStore";
import { ConnectionList } from "./components/ConnectionList";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import type { QueryEditorSessionState } from "./components/SQLEditor";
import type { Tab } from "./types";
import "./index.css";

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

const GLOBAL_ERROR_AUTO_DISMISS_MS = 8000;
const SQLEditor = lazy(() => import("./components/SQLEditor").then((module) => ({ default: module.SQLEditor })));
const DataGrid = lazy(() => import("./components/DataGrid").then((module) => ({ default: module.DataGrid })));
const TableStructure = lazy(() => import("./components/TableStructure").then((module) => ({ default: module.TableStructure })));
const ConnectionForm = lazy(() => import("./components/ConnectionForm").then((module) => ({ default: module.ConnectionForm })));
const AISettingsModal = lazy(() => import("./components/AISettingsModal").then((module) => ({ default: module.AISettingsModal })));
const AISlidePanel = lazy(() => import("./components/AISlidePanel/AISlidePanel").then((module) => ({ default: module.AISlidePanel })));

function LazyPanelFallback() {
  return (
    <div className="flex items-center justify-center h-full min-h-[220px] text-sm text-[var(--text-muted)]">
      Loading workspace...
    </div>
  );
}

function getLastPathSegment(value?: string | null) {
  if (!value) return "";
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
}

function App() {
  const {
    activeConnectionId,
    connectedIds,
    connections,
    tabs,
    activeTabId,
    currentDatabase,
    error,
    clearError,
    loadSavedConnections,
    addTab,
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
      error: state.error,
      clearError: state.clearError,
      loadSavedConnections: state.loadSavedConnections,
      addTab: state.addTab,
      fetchDatabases: state.fetchDatabases,
      fetchTables: state.fetchTables,
      fetchSchemaObjects: state.fetchSchemaObjects,
    }))
  );

  const [connectionFormIntent, setConnectionFormIntent] = useState<"connect" | "bootstrap" | null>(null);
  const [showAISettings, setShowAISettings] = useState(false);
  const [showAISlidePanel, setShowAISlidePanel] = useState(false);
  const [aiPanelDraft, setAiPanelDraft] = useState<{ prompt: string; nonce: number } | null>(null);
  const [leftPanel, setLeftPanel] = useState<"connections" | "database">("connections");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [isWindowFocused, setIsWindowFocused] = useState(true);
  const [queryChromeByTab, setQueryChromeByTab] = useState<Record<string, QueryChromeState>>({});
  const [querySessionByTab, setQuerySessionByTab] = useState<Record<string, QueryEditorSessionState>>({});
  const [queryRunRequestByTab, setQueryRunRequestByTab] = useState<Record<string, number>>({});
  const [workspaceActivityByConnection, setWorkspaceActivityByConnection] = useState<
    Record<string, WorkspaceActivityState>
  >({});

  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(300);
  const isDesktopWindow = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const activeConn = connections.find((conn) => conn.id === activeConnectionId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;
  const isConnected = !!(activeConnectionId && connectedIds.has(activeConnectionId));
  const activeQueryChrome =
    activeTab?.type === "query" ? queryChromeByTab[activeTab.id] ?? { isRunning: false } : null;
  const activeWorkspaceActivity =
    activeConnectionId ? workspaceActivityByConnection[activeConnectionId] ?? null : null;
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

  useEffect(() => {
    if (!error) return;

    const timeoutId = window.setTimeout(() => {
      clearError();
    }, GLOBAL_ERROR_AUTO_DISMISS_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [clearError, error]);

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
    addTab({
      id: `query-${crypto.randomUUID()}`,
      type: "query",
      title: nextIndex === 1 ? "Query" : `Query ${nextIndex}`,
      connectionId: activeConnectionId,
      database: currentDatabase || undefined,
      content: "",
    });
  }, [activeConnectionId, addTab, currentDatabase, queryTabCount]);

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

  const handleRunActiveQuery = useCallback(() => {
    if (activeTab?.type !== "query") return;

    setQueryRunRequestByTab((prev) => ({
      ...prev,
      [activeTab.id]: (prev[activeTab.id] ?? 0) + 1,
    }));
  }, [activeTab]);

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
        current?.queryCount === state.queryCount &&
        current?.editorHeight === state.editorHeight
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

  const handleOpenAISlidePanel = useCallback((prompt?: string) => {
    if (typeof prompt === "string" && prompt.trim()) {
      setAiPanelDraft({
        prompt,
        nonce: Date.now(),
      });
    }
    setShowAISlidePanel(true);
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((collapsed) => !collapsed);
  }, []);

  const handleStartWindowDrag = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (!isDesktopWindow || e.button !== 0) return;

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
    },
    [isDesktopWindow],
  );

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

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;

      const delta = e.clientX - startX.current;
      const nextWidth = Math.max(260, Math.min(440, startWidth.current + delta));
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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const metaPressed = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (metaPressed && !e.altKey && key === "p") {
        e.preventDefault();
        e.stopPropagation();
        handleOpenAISlidePanel();
        return;
      }

      if (metaPressed && key === "n") {
        e.preventDefault();
        handleNewQuery();
        return;
      }

      if (metaPressed && key === "b") {
        e.preventDefault();
        handleToggleSidebar();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleNewQuery, handleOpenAISlidePanel, handleToggleSidebar]);

  useEffect(() => {
    const handleOpenAI = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: string }>).detail;
      handleOpenAISlidePanel(detail?.prompt);
    };
    window.addEventListener("open-ai-slide-panel", handleOpenAI);
    return () => window.removeEventListener("open-ai-slide-panel", handleOpenAI);
  }, [handleOpenAISlidePanel]);

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
    if (activeConnectionId && connectedIds.has(activeConnectionId)) {
      setLeftPanel("database");
      return;
    }

    setLeftPanel("connections");
  }, [activeConnectionId, connectedIds]);

  const renderTabContent = () => {
    if (!isConnected) {
      return (
        <div className="workspace-empty">
          <div className="workspace-empty-panel">
            <div className="workspace-empty-hero">
              <div className="workspace-empty-icon">
                <Database className="w-10 h-10 text-[var(--accent)]" />
              </div>

              <div className="workspace-empty-copy">
                <span className="workspace-empty-kicker">Get Started</span>
                <h2 className="workspace-empty-title">No active connection</h2>
                <p className="workspace-empty-description">
                  Create or open a saved connection to unlock Explorer, SQL Editor, and table
                  tools in this workspace.
                </p>
              </div>
            </div>

            <div className="workspace-empty-actions">
              <button onClick={() => setConnectionFormIntent("connect")} className="btn btn-primary">
                <Plus className="w-3.5 h-3.5" />
                New Connection
              </button>
              <button onClick={() => setConnectionFormIntent("bootstrap")} className="btn btn-secondary">
                <Database className="w-3.5 h-3.5" />
                Create Local DB
              </button>
            </div>

            <div className="workspace-empty-grid">
              <div className="workspace-empty-card">
                <span className="workspace-empty-card-kicker">Connections</span>
                <strong className="workspace-empty-card-title">Saved workspaces</strong>
                <p className="workspace-empty-card-copy">
                  Reopen an existing connection from the left panel or create a new one here.
                </p>
              </div>

              <div className="workspace-empty-card">
                <span className="workspace-empty-card-kicker">Supported</span>
                <strong className="workspace-empty-card-title">Primary engines</strong>
                <p className="workspace-empty-card-copy">
                  MySQL, PostgreSQL, and SQLite are ready now. Other engines stay visible as the
                  roadmap.
                </p>
              </div>

              <div className="workspace-empty-card">
                <span className="workspace-empty-card-kicker">Workflow</span>
                <strong className="workspace-empty-card-title">From connect to query</strong>
                <p className="workspace-empty-card-copy">
                  Connect first, then browse tables from Explorer or open a query tab to start
                  working.
                </p>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="workspace-empty">
        <div className="workspace-empty-panel">
          <div className="workspace-empty-hero">
            <div className="workspace-empty-icon">
              <Sparkles className="w-10 h-10 text-[var(--accent)]" />
            </div>

            <div className="workspace-empty-copy">
              <span className="workspace-empty-kicker">Workspace</span>
              <h2 className="workspace-empty-title">Workspace is ready</h2>
              <p className="workspace-empty-description">
                Start with a fresh query, browse a table from Explorer, or open AI assistance to
                generate and explain SQL faster.
              </p>
            </div>
          </div>

          <div className="workspace-empty-grid">
            <div className="workspace-empty-card">
              <span className="workspace-empty-card-kicker">SQL Editor</span>
              <strong className="workspace-empty-card-title">Write a new query</strong>
              <p className="workspace-empty-card-copy">
                Open a fresh tab and run statements immediately against the active database.
              </p>
              <div className="workspace-empty-card-shortcut">
                <kbd className="kbd">Ctrl+N</kbd>
                <span>new query</span>
              </div>
            </div>

            <div className="workspace-empty-card">
              <span className="workspace-empty-card-kicker">Explorer</span>
              <strong className="workspace-empty-card-title">Jump to a table</strong>
              <p className="workspace-empty-card-copy">
                Search the current database, then open data rows or inspect structure.
              </p>
              <div className="workspace-empty-card-shortcut">
                <kbd className="kbd">Ctrl+B</kbd>
                <span>toggle sidebar</span>
              </div>
            </div>

            <div className="workspace-empty-card">
              <span className="workspace-empty-card-kicker">AI Assist</span>
              <strong className="workspace-empty-card-title">Generate and explain SQL</strong>
              <p className="workspace-empty-card-copy">
                Use AI when you want faster drafts, query explanations, or schema-aware help.
              </p>
              <div className="workspace-empty-card-shortcut">
                <kbd className="kbd">Ctrl+Shift+P</kbd>
                <span>open AI</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderSingleTab = (tab: Tab, isActive: boolean) => {
    switch (tab.type) {
      case "query":
        return (
          <Suspense fallback={<LazyPanelFallback />}>
            <SQLEditor
              key={tab.id}
              connectionId={tab.connectionId}
              initialContent={tab.content || ""}
              tabId={tab.id}
              initialState={querySessionByTab[tab.id]}
              runRequestNonce={queryRunRequestByTab[tab.id] ?? 0}
              onChromeChange={(state) => handleQueryChromeChange(tab.id, state)}
              onStateChange={(state) => handleQuerySessionChange(tab.id, state)}
            />
          </Suspense>
        );
      case "table":
        return (
          <Suspense fallback={<LazyPanelFallback />}>
            <DataGrid
              key={tab.id}
              connectionId={tab.connectionId}
              tableName={tab.tableName}
              database={tab.database}
              isActive={isActive}
            />
          </Suspense>
        );
      case "structure":
        return (
          <Suspense fallback={<LazyPanelFallback />}>
            <TableStructure
              key={tab.id}
              connectionId={tab.connectionId}
              tableName={tab.tableName || ""}
              database={tab.database}
              isActive={isActive}
            />
          </Suspense>
        );
      default:
        return null;
    }
  };

  const renderSidebarRail = () => (
    <div className="sidebar-rail">
      <button
        type="button"
        className={`sidebar-rail-btn ${leftPanel === "connections" ? "active" : ""}`}
        onClick={() => {
          setIsSidebarCollapsed(false);
          setLeftPanel("connections");
        }}
        title="Connections"
      >
        <Cable className="w-4 h-4" />
      </button>

      <button
        type="button"
        className={`sidebar-rail-btn ${leftPanel === "database" ? "active" : ""}`}
        onClick={() => {
          if (!isConnected) return;
          setIsSidebarCollapsed(false);
          setLeftPanel("database");
        }}
        title="Explorer"
        disabled={!isConnected}
      >
        <FolderTree className="w-4 h-4" />
      </button>

      <button
        type="button"
        className="sidebar-rail-btn"
        onClick={() => setConnectionFormIntent("connect")}
        title="New Connection"
      >
        <Plus className="w-4 h-4" />
      </button>

      <div className="sidebar-rail-spacer" />

      <button
        type="button"
        className="sidebar-rail-btn"
        onClick={handleToggleSidebar}
        title="Expand Sidebar"
      >
        <PanelRightClose className="w-4 h-4 rotate-180" />
      </button>
    </div>
  );

  return (
    <div className={`app-root ${isWindowMaximized ? "window-maximized" : ""}`}>
      <header
        className={`titlebar ${isWindowFocused ? "" : "inactive"}`}
        onMouseDown={handleStartWindowDrag}
      >
        <div
          className="titlebar-drag-strip"
          onDoubleClick={handleToggleMaximizeWindow}
        >
          <div className="titlebar-brand">
            <Database className="w-4 h-4 text-[var(--accent)]" />
            <span className="titlebar-name">TableR</span>
          </div>

          <div className="titlebar-divider" />

          <div className="titlebar-context">
            <span className="titlebar-context-label">Workspace</span>
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
                <span className="truncate">No active connection</span>
              </div>
            )}
          </div>

          <div className="titlebar-spacer" />
        </div>

        <div className="titlebar-actions" data-no-window-drag="true">
          <button
            onClick={() => setShowAISettings(true)}
            className="titlebar-icon-btn"
            title="AI Settings"
          >
            <Settings2 className="w-4 h-4" />
          </button>

          <button
            onClick={handleToggleSidebar}
            className="titlebar-icon-btn"
            title={isSidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
          >
            <PanelRightClose className={`w-4 h-4 ${isSidebarCollapsed ? "rotate-180" : ""}`} />
          </button>
        </div>

        {isDesktopWindow && (
          <div className="titlebar-window-controls" data-no-window-drag="true">
            <button
              type="button"
              onClick={handleMinimizeWindow}
              className="titlebar-window-btn"
              title="Minimize"
              aria-label="Minimize window"
            >
              <Minus className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleToggleMaximizeWindow}
              className="titlebar-window-btn"
              title={isWindowMaximized ? "Restore" : "Maximize"}
              aria-label={isWindowMaximized ? "Restore window" : "Maximize window"}
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
              title="Close"
              aria-label="Close window"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </header>

      {error && (
        <div className="error-bar">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={clearError} className="error-bar-close">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="main-container">
        <aside
          className={`sidebar ${isSidebarCollapsed ? "sidebar-collapsed" : ""}`}
          style={{ width: isSidebarCollapsed ? 76 : sidebarWidth }}
        >
          {isSidebarCollapsed ? (
            renderSidebarRail()
          ) : leftPanel === "connections" ? (
            <ConnectionList
              onNewConnection={() => setConnectionFormIntent("connect")}
              onCreateLocalDatabase={() => setConnectionFormIntent("bootstrap")}
            />
          ) : (
            <Sidebar />
          )}
        </aside>

        {!isSidebarCollapsed && (
          <div className="resize-handle" onMouseDown={handleMouseDown}>
            <div className="resize-handle-line" />
          </div>
        )}

        <main className="main-content">
          <div className="workspace-toolbar">
            <div className="workspace-toolbar-main">
              <div className="workspace-toolbar-topline">
                <span className="workspace-toolbar-kicker">
                  {activeTab
                    ? activeTab.type === "query"
                      ? "SQL Workspace"
                      : activeTab.type === "table"
                        ? "Table View"
                        : "Structure View"
                    : "Workspace"}
                </span>
                {isConnected && activeConn && (
                  <span className="workspace-toolbar-chip">
                    {activeConn.name || activeConn.host}
                    {activeDatabaseLabel ? ` / ${activeDatabaseLabel}` : ""}
                  </span>
                )}
                {activeWorkspaceActivity && (
                  <span className="workspace-toolbar-mini-note">
                    {activeWorkspaceActivity.label} {activeWorkspaceActivity.durationMs}ms
                  </span>
                )}
              </div>

              <div className="workspace-toolbar-title-row">
                <span className="workspace-toolbar-title">
                  {activeTab?.title || (isConnected ? "Ready for queries" : "No active connection")}
                </span>
                {activeQueryChrome?.executionTimeMs !== undefined && (
                  <div className="workspace-toolbar-status">
                    <span className="workspace-toolbar-status-pill success">Success</span>
                    <span className="workspace-toolbar-status-pill">
                      {activeQueryChrome.executionTimeMs}ms
                    </span>
                    {typeof activeQueryChrome.rowCount === "number" && activeQueryChrome.rowCount > 0 && (
                      <span className="workspace-toolbar-status-pill">
                        {activeQueryChrome.rowCount} rows
                      </span>
                    )}
                    {typeof activeQueryChrome.affectedRows === "number" && activeQueryChrome.affectedRows > 0 && (
                      <span className="workspace-toolbar-status-pill warning">
                        {activeQueryChrome.affectedRows} affected
                      </span>
                    )}
                    {typeof activeQueryChrome.queryCount === "number" && activeQueryChrome.queryCount > 1 && (
                      <span className="workspace-toolbar-status-pill">
                        batch {activeQueryChrome.queryCount}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="workspace-toolbar-actions">
              {isConnected && (
                <>
                  <button
                    onClick={handleNewQuery}
                    className="toolbar-btn primary"
                    title="New Query (Ctrl+N)"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>New Query</span>
                  </button>

                  <div className="workspace-toolbar-utility">
                    <button
                      onClick={() => void handleRefreshWorkspace()}
                      className="toolbar-btn icon-only"
                      title="Refresh workspace"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>

                    <button
                      onClick={handleFocusExplorerSearch}
                      className="toolbar-btn icon-only"
                      title="Find Table"
                    >
                      <Search className="w-3.5 h-3.5" />
                    </button>

                    <button
                      onClick={() => handleOpenAISlidePanel()}
                      className="toolbar-btn icon-only"
                      title="Ask AI (Ctrl+Shift+P or Ctrl+P)"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          <TabBar
            queryChrome={activeQueryChrome}
            onRunActiveQuery={handleRunActiveQuery}
          />

          <div className="tab-content">
            {tabs.length === 0 || !activeTab ? (
              renderTabContent()
            ) : (
              <div
                key={activeTab.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  height: "100%",
                  width: "100%",
                }}
              >
                {renderSingleTab(activeTab, true)}
              </div>
            )}
          </div>
        </main>
      </div>

      <footer className="statusbar">
        <div className="statusbar-left">
          <span className={`statusbar-indicator ${isConnected ? "connected" : ""}`}>
            <span className="statusbar-dot" />
            {isConnected ? "Connected" : "Disconnected"}
          </span>
          {isConnected && activeConn && (
            <span className="statusbar-info">
              {activeConn.db_type.toUpperCase()}
              {currentDatabase ? ` | ${currentDatabase}` : ""}
              {activeWorkspaceActivity ? ` | ${activeWorkspaceActivity.label} ${activeWorkspaceActivity.durationMs}ms` : ""}
            </span>
          )}
        </div>

        <div className="statusbar-right">
          <span className="statusbar-shortcuts">
            <kbd className="kbd">Ctrl+N</kbd>
            <kbd className="kbd">Ctrl+B</kbd>
            <kbd className="kbd">Ctrl+Shift+P</kbd>
          </span>
          <span>TableR v0.1.0</span>
        </div>
      </footer>

      {connectionFormIntent && (
        <Suspense fallback={null}>
          <ConnectionForm
            initialIntent={connectionFormIntent}
            onClose={() => setConnectionFormIntent(null)}
          />
        </Suspense>
      )}
      {showAISettings && (
        <Suspense fallback={null}>
          <AISettingsModal onClose={() => setShowAISettings(false)} />
        </Suspense>
      )}
      {showAISlidePanel && (
        <Suspense fallback={null}>
          <AISlidePanel
            isOpen={showAISlidePanel}
            initialPrompt={aiPanelDraft?.prompt ?? ""}
            initialPromptNonce={aiPanelDraft?.nonce ?? 0}
            onClose={() => setShowAISlidePanel(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
