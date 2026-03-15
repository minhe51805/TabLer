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
  Database,
  FolderTree,
  PanelRightClose,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
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

  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(300);

  const activeConn = connections.find((conn) => conn.id === activeConnectionId);
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
          <Database className="w-16 h-16 mb-5 opacity-35 text-[var(--accent)]" />
          <p className="text-base font-semibold opacity-95">No active connection</p>
          <p className="text-xs mt-2 opacity-90 max-w-md text-center">
            Start by creating or opening a connection. Once connected, Explorer and SQL Editor
            become available immediately.
          </p>
          <div className="workspace-empty-actions">
            <button onClick={() => setShowConnectionForm(true)} className="btn btn-primary">
              <Plus className="w-3.5 h-3.5" />
              New Connection
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="workspace-empty">
        <Sparkles className="w-16 h-16 mb-5 opacity-35 text-[var(--accent)]" />
        <p className="text-base font-semibold opacity-95">Workspace is ready</p>
        <p className="text-xs mt-2 opacity-90 max-w-lg text-center">
          Create a new query to run SQL, or open a table from Explorer to inspect data and
          structure.
        </p>
        <div className="workspace-empty-actions">
          <button onClick={handleNewQuery} className="btn btn-primary">
            <Plus className="w-3.5 h-3.5" />
            New Query
          </button>
          <button onClick={handleFocusExplorerSearch} className="btn btn-secondary">
            <Search className="w-3.5 h-3.5" />
            Find Table
          </button>
        </div>
        <p className="text-[11px] text-[var(--text-muted)] mt-4">
          Shortcuts: <kbd className="kbd">Ctrl+N</kbd> creates a query,{" "}
          <kbd className="kbd">Ctrl+Shift+K</kbd> opens AI.
        </p>
      </div>
    );
  };

  const renderSingleTab = (tab: Tab) => {
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
          />
        );
      case "structure":
        return (
          <TableStructure
            key={tab.id}
            connectionId={tab.connectionId}
            tableName={tab.tableName || ""}
            database={tab.database}
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
    <div className="app-root">
      <header className="titlebar">
        <div className="titlebar-brand" data-tauri-drag-region>
          <Database className="w-4 h-4 text-[var(--accent)]" />
          <span className="titlebar-name">TableR</span>
        </div>



        <div className="titlebar-spacer" data-tauri-drag-region />

        <div className="titlebar-actions">
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

        {isConnected && activeConn && (
          <div className="titlebar-badge">
            <span
              className="w-2 h-2 rounded-sm shrink-0"
              style={{ backgroundColor: activeConn.color || "var(--success)" }}
            />
            <span className="truncate">
              {activeConn.name || activeConn.host}
              {currentDatabase ? ` / ${currentDatabase}` : ""}
            </span>
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
                  {renderSingleTab(tab)}
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
