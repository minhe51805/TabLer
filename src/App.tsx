import {
  useState,
  useEffect,
  useRef,
  useCallback,
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
  Terminal,
  X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "./stores/appStore";
import { ConnectionList } from "./components/ConnectionList";
import { ConnectionForm } from "./components/ConnectionForm";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { DataGrid } from "./components/DataGrid";
import { SQLEditor } from "./components/SQLEditor";
import { TableStructure } from "./components/TableStructure";
import { TerminalPanel } from "./components/TerminalPanel";
import { AISettingsModal } from "./components/AISettingsModal";
import { AISlidePanel } from "./components/AISlidePanel/AISlidePanel";
import type { Tab } from "./types";
import "./index.css";

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
  } = useAppStore();

  const [showConnectionForm, setShowConnectionForm] = useState(false);
  const [showAISettings, setShowAISettings] = useState(false);
  const [showAISlidePanel, setShowAISlidePanel] = useState(false);
  const [leftPanel, setLeftPanel] = useState<"connections" | "database">("connections");
  const [showEmbeddedTerminal, setShowEmbeddedTerminal] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [isWindowFocused, setIsWindowFocused] = useState(true);

  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(300);
  const isDesktopWindow = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const activeConn = connections.find((conn) => conn.id === activeConnectionId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;
  const isConnected = !!(activeConnectionId && connectedIds.has(activeConnectionId));
  const queryTabCount = tabs.filter(
    (tab) => tab.type === "query" && tab.connectionId === activeConnectionId,
  ).length;

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
      await fetchTables(activeConnectionId, currentDatabase);
    }
  }, [activeConnectionId, currentDatabase, fetchDatabases, fetchTables]);

  const handleFocusExplorerSearch = useCallback(() => {
    if (!isConnected) return;

    setIsSidebarCollapsed(false);
    setLeftPanel("database");
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("focus-explorer-search"));
    }, 0);
  }, [isConnected]);

  const handleToggleEmbeddedTerminal = useCallback(() => {
    setShowEmbeddedTerminal((visible) => {
      const nextVisible = !visible;
      if (nextVisible) {
        window.dispatchEvent(new CustomEvent("close-sql-terminal"));
      }
      return nextVisible;
    });
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

      if (metaPressed && e.shiftKey && key === "k") {
        e.preventDefault();
        setShowAISlidePanel((prev) => !prev);
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

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNewQuery, handleToggleSidebar]);

  useEffect(() => {
    const handleOpenAI = () => setShowAISlidePanel(true);
    window.addEventListener("open-ai-slide-panel", handleOpenAI);
    return () => window.removeEventListener("open-ai-slide-panel", handleOpenAI);
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
              <button onClick={() => setShowConnectionForm(true)} className="btn btn-primary">
                <Plus className="w-3.5 h-3.5" />
                New Connection
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

          <div className="workspace-empty-actions">
            <button onClick={handleNewQuery} className="btn btn-primary">
              <Plus className="w-3.5 h-3.5" />
              New Query
            </button>
            <button onClick={handleFocusExplorerSearch} className="btn btn-secondary">
              <Search className="w-3.5 h-3.5" />
              Find Table
            </button>
            <button onClick={() => setShowAISlidePanel(true)} className="btn btn-secondary">
              <Sparkles className="w-3.5 h-3.5" />
              Ask AI
            </button>
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
                <kbd className="kbd">Ctrl+Shift+K</kbd>
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
          <SQLEditor
            key={tab.id}
            connectionId={tab.connectionId}
            database={tab.database}
            initialContent={tab.content || ""}
            tabId={tab.id}
            onTerminalToggle={(show) => {
              if (show) {
                setShowEmbeddedTerminal(false);
              }
            }}
          />
        );
      case "table":
        return (
          <DataGrid
            key={tab.id}
            connectionId={tab.connectionId}
            tableName={tab.tableName}
            database={tab.database}
            isActive={isActive}
          />
        );
      case "structure":
        return (
          <TableStructure
            key={tab.id}
            connectionId={tab.connectionId}
            tableName={tab.tableName || ""}
            database={tab.database}
            isActive={isActive}
          />
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
        onClick={() => setShowConnectionForm(true)}
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
              <div className="titlebar-badge" title={`${activeConn.name || activeConn.host}${currentDatabase ? ` / ${currentDatabase}` : ""}`}>
                <span
                  className="w-2 h-2 rounded-sm shrink-0"
                  style={{ backgroundColor: activeConn.color || "var(--success)" }}
                />
                <span className="truncate">
                  {activeConn.name || activeConn.host}
                  {currentDatabase ? ` / ${currentDatabase}` : ""}
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
            <ConnectionList onNewConnection={() => setShowConnectionForm(true)} />
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
            <div className="workspace-toolbar-copy">
              <span className="workspace-toolbar-kicker">
                {activeTab
                  ? activeTab.type === "query"
                    ? "SQL Workspace"
                    : activeTab.type === "table"
                      ? "Table View"
                      : "Structure View"
                  : "Workspace"}
              </span>
              <div className="workspace-toolbar-title-row">
                <span className="workspace-toolbar-title">
                  {activeTab?.title || (isConnected ? "Ready for queries" : "No active connection")}
                </span>
                {isConnected && activeConn && (
                  <span className="workspace-toolbar-chip">
                    {activeConn.name || activeConn.host}
                    {currentDatabase ? ` / ${currentDatabase}` : ""}
                  </span>
                )}
              </div>
            </div>

            <div className="workspace-toolbar-actions">
              <button
                onClick={handleNewQuery}
                disabled={!isConnected}
                className="toolbar-btn primary"
                title="New Query (Ctrl+N)"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Query</span>
              </button>

              <button
                onClick={() => void handleRefreshWorkspace()}
                disabled={!isConnected}
                className="toolbar-btn"
                title="Refresh"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={handleFocusExplorerSearch}
                disabled={!isConnected}
                className="toolbar-btn"
                title="Find Table"
              >
                <Search className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={() => setShowAISlidePanel(true)}
                className="toolbar-btn"
                title="Ask AI (Ctrl+Shift+K)"
              >
                <Sparkles className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={handleToggleEmbeddedTerminal}
                className="toolbar-btn"
                title="Toggle Terminal"
              >
                <Terminal className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <TabBar onNewQuery={handleNewQuery} />

          <div className="tab-content" style={{ display: showEmbeddedTerminal ? "none" : "block" }}>
            {tabs.length === 0 || !activeTabId ? (
              renderTabContent()
            ) : (
              tabs.map((tab) => (
                <div
                  key={tab.id}
                  style={{
                    display: tab.id === activeTabId ? "flex" : "none",
                    flexDirection: "column",
                    height: "100%",
                    width: "100%",
                  }}
                >
                  {renderSingleTab(tab, tab.id === activeTabId)}
                </div>
              ))
            )}
          </div>

          {showEmbeddedTerminal && (
            <div className="embedded-terminal-panel">
              <TerminalPanel initialCwd="." />
            </div>
          )}
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
            </span>
          )}
        </div>

        <div className="statusbar-right">
          <button
            type="button"
            className="terminal-launch-btn"
            onClick={handleToggleEmbeddedTerminal}
            title="Toggle embedded terminal"
            aria-label="Toggle embedded terminal"
          >
            <Terminal className="w-4 h-4" />
          </button>
          <span className="statusbar-shortcuts">
            <kbd className="kbd">Ctrl+N</kbd>
            <kbd className="kbd">Ctrl+B</kbd>
            <kbd className="kbd">Ctrl+Shift+K</kbd>
          </span>
          <span>TableR v0.1.0</span>
        </div>
      </footer>

      {showConnectionForm && <ConnectionForm onClose={() => setShowConnectionForm(false)} />}
      {showAISettings && <AISettingsModal onClose={() => setShowAISettings(false)} />}
      <AISlidePanel isOpen={showAISlidePanel} onClose={() => setShowAISlidePanel(false)} />
    </div>
  );
}

export default App;
