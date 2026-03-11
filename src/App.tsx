import { useState, useEffect, useRef, useCallback } from "react";
import { useAppStore } from "./stores/appStore";
import { ConnectionList } from "./components/ConnectionList";
import { ConnectionForm } from "./components/ConnectionForm";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { DataGrid } from "./components/DataGrid";
import { SQLEditor } from "./components/SQLEditor";
import { TableStructure } from "./components/TableStructure";
import { TerminalPanel } from "./components/TerminalPanel";
import {
  Database,
  Cable,
  FolderTree,
  AlertCircle,
  X,
  Terminal,
  Sparkles,
  Plus,
  RotateCcw,
  Filter,
  Download,
  Upload,
  Search,
  PanelRightClose,
} from "lucide-react";
import { AISettingsModal } from "./components/AISettingsModal";
import { AISlidePanel } from "./components/AISlidePanel/AISlidePanel";
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
  } = useAppStore();

  const [showConnectionForm, setShowConnectionForm] = useState(false);
  const [showAISettings, setShowAISettings] = useState(false);
  const [showAISlidePanel, setShowAISlidePanel] = useState(false);
  const [leftPanel, setLeftPanel] = useState<"connections" | "database">("connections");
  const [showEmbeddedTerminal, setShowEmbeddedTerminal] = useState(false);

  const [sidebarWidth, setSidebarWidth] = useState(280);
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(280);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isResizing.current = true;
    startX.current = e.clientX;
    startWidth.current = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [sidebarWidth]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = e.clientX - startX.current;
      const newW = Math.max(220, Math.min(500, startWidth.current + delta));
      setSidebarWidth(newW);
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
    loadSavedConnections();
  }, []);

  // Global keyboard shortcut: Ctrl+Shift+K to open AI Slide Panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowAISlidePanel(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Listen for open AI slide panel events from child components
  useEffect(() => {
    const handleOpenAI = () => setShowAISlidePanel(true);
    window.addEventListener('open-ai-slide-panel', handleOpenAI);
    return () => window.removeEventListener('open-ai-slide-panel', handleOpenAI);
  });

  // Toolbar button handlers
  useEffect(() => {
    const handleNewTab = () => {
      // Trigger new tab creation
      const event = new CustomEvent('new-tab');
      window.dispatchEvent(event);
    };
    const handleRefreshTables = () => {
      window.dispatchEvent(new CustomEvent('refresh-tables'));
    };
    const handleSearch = () => {
      window.dispatchEvent(new CustomEvent('focus-search'));
    };
    const handleFilter = () => {
      window.dispatchEvent(new CustomEvent('toggle-filter'));
    };
    const handleExport = () => {
      window.dispatchEvent(new CustomEvent('export-data'));
    };
    const handleImport = () => {
      window.dispatchEvent(new CustomEvent('import-data'));
    };
    const handleToggleRight = () => {
      // Toggle right panel visibility - dispatch to Sidebar component
      window.dispatchEvent(new CustomEvent('toggle-right-panel'));
    };

    window.addEventListener('new-tab', handleNewTab);
    window.addEventListener('refresh-tables', handleRefreshTables);
    window.addEventListener('focus-search', handleSearch);
    window.addEventListener('toggle-filter', handleFilter);
    window.addEventListener('export-data', handleExport);
    window.addEventListener('import-data', handleImport);
    window.addEventListener('toggle-right-panel', handleToggleRight);

    return () => {
      window.removeEventListener('new-tab', handleNewTab);
      window.removeEventListener('refresh-tables', handleRefreshTables);
      window.removeEventListener('focus-search', handleSearch);
      window.removeEventListener('toggle-filter', handleFilter);
      window.removeEventListener('export-data', handleExport);
      window.removeEventListener('import-data', handleImport);
      window.removeEventListener('toggle-right-panel', handleToggleRight);
    };
  }, [isConnected]);

  useEffect(() => {
    if (activeConnectionId && connectedIds.has(activeConnectionId)) {
      setLeftPanel("database");
    } else {
      setLeftPanel("connections");
    }
  }, [activeConnectionId, connectedIds]);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeConn = connections.find((c) => c.id === activeConnectionId);
  const isConnected = !!(activeConnectionId && connectedIds.has(activeConnectionId));

  const renderTabContent = () => {
    if (!activeTab || !activeConnectionId) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-[var(--text-secondary)] select-none">
          <Database className="w-16 h-16 mb-5 opacity-35 text-[var(--accent)]" />
          <p className="text-base font-semibold opacity-95">No tab open</p>
          <p className="text-xs mt-2 opacity-90">
            Open a table from the sidebar or press{" "}
            <kbd className="px-1.5 py-0.5 bg-[var(--bg-surface)] rounded-sm text-[10px] font-mono">
              Ctrl+N
            </kbd>{" "}
            for a new query
          </p>
        </div>
      );
    }

    return null;
  };

  const renderSingleTab = (tab: import("./types").Tab) => {
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
            tableName={tab.tableName!}
            database={tab.database}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="app-root">
      <header className="titlebar" data-tauri-drag-region>
        <div className="titlebar-brand" data-tauri-drag-region>
          <Database className="!w-4 !h-4 text-[var(--accent)]" />
          <span className="titlebar-name">TableR</span>
        </div>

        <nav className="titlebar-nav">
          <button
            onClick={() => setLeftPanel("connections")}
            className={`titlebar-nav-btn ${leftPanel === "connections" ? "active" : ""}`}
          >
            <Cable className="!w-3.5 !h-3.5" />
            <span>Connections</span>
          </button>
          <button
            onClick={() => setLeftPanel("database")}
            disabled={!isConnected}
            className={`titlebar-nav-btn ${leftPanel === "database" ? "active" : ""}`}
          >
            <FolderTree className="w-3.5 h-3.5" />
            <span>Explorer</span>
          </button>
          <button
            onClick={() => setShowAISettings(true)}
            className="titlebar-nav-btn"
            title="AI Settings"
          >
            <Sparkles className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => {
              // Trigger new tab
              window.dispatchEvent(new CustomEvent('new-tab'));
            }}
            className="titlebar-nav-btn"
            title="New Tab"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => {
              // Trigger refresh tables
              window.dispatchEvent(new CustomEvent('refresh-tables'));
            }}
            disabled={!isConnected}
            className="titlebar-nav-btn"
            title="Refresh Tables"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => {
              // Focus search
              window.dispatchEvent(new CustomEvent('focus-search'));
            }}
            disabled={!isConnected}
            className="titlebar-nav-btn"
            title="Search Tables"
          >
            <Search className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => {
              // Toggle filter panel
              window.dispatchEvent(new CustomEvent('toggle-filter'));
            }}
            disabled={!isConnected}
            className="titlebar-nav-btn"
            title="Filters"
          >
            <Filter className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => {
              // Export
              window.dispatchEvent(new CustomEvent('export-data'));
            }}
            disabled={!isConnected}
            className="titlebar-nav-btn"
            title="Export"
          >
            <Download className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => {
              // Import
              window.dispatchEvent(new CustomEvent('import-data'));
            }}
            disabled={!isConnected}
            className="titlebar-nav-btn"
            title="Import"
          >
            <Upload className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => {
              // Toggle right panel
            }}
            className="titlebar-nav-btn"
            title="Toggle Sidebar"
          >
            <PanelRightClose className="w-3.5 h-3.5" style={{ transform: 'rotate(180deg)' }} />
          </button>
        </nav>

        {isConnected && activeConn && (
          <div className="titlebar-badge" data-tauri-drag-region>
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

      <div className="main-container !px-2">
        <aside className="sidebar" style={{ width: sidebarWidth }}>
          {leftPanel === "connections" ? (
            <ConnectionList onNewConnection={() => setShowConnectionForm(true)} />
          ) : (
            <Sidebar />
          )}
        </aside>

        <div className="resize-handle" onMouseDown={handleMouseDown}>
          <div className="resize-handle-line" />
        </div>

        <main className="main-content">
          <TabBar />
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
              {currentDatabase ? ` · ${currentDatabase}` : ""}
            </span>
          )}
        </div>
        <div className="statusbar-right">
          <button
            type="button"
            className="terminal-launch-btn"
            onClick={() => {
              setShowEmbeddedTerminal((v) => {
                const newValue = !v;
                if (newValue) {
                  // When terminal large is opened, close any terminal in SQL Editor
                  // We'll use a custom event to notify SQL Editor
                  window.dispatchEvent(new CustomEvent("close-sql-terminal"));
                }
                return newValue;
              });
            }}
            title="Toggle embedded terminal"
            aria-label="Toggle embedded terminal"
          >
            <Terminal className="w-4 h-4" />
          </button>
          <span>TableR v0.1.0</span>
        </div>
      </footer>

      {showConnectionForm && (
        <ConnectionForm onClose={() => setShowConnectionForm(false)} />
      )}
      {showAISettings && (
        <AISettingsModal onClose={() => setShowAISettings(false)} />
      )}
      <AISlidePanel
        isOpen={showAISlidePanel}
        onClose={() => setShowAISlidePanel(false)}
      />
    </div>
  );
}

export default App;
