import {
  FolderTree,
  BarChart3,
  Plus,
  GitBranch,
  Terminal,
  Download,
  X,
  RotateCcw,
  Search,
  Sparkles,
  PanelRightClose,
  MoreHorizontal,
  Database,
  AlertCircle,
  LoaderCircle,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { WorkspaceErrorFallback } from "./layout/WorkspaceErrorFallback";
import { MetricsSidebar } from "./MetricsSidebar/MetricsSidebar";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
// Lazy-loaded components (performance optimization P1/P2)
const DataGrid = lazy(() => import("./DataGrid/DataGrid").then((m) => ({ default: m.DataGrid })));
const ERDiagram = lazy(() => import("./ERDiagram/ERDiagram").then((m) => ({ default: m.default })));
const TerminalDock = lazy(() => import("./TerminalDock/TerminalDock").then((m) => ({ default: m.TerminalDock })));
import type { Tab } from "../types";
import type { ConnectionConfig } from "../types/database";
import type { QueryEditorSessionState } from "./SQLEditor";
import { useI18n } from "../i18n";
import { useEvent } from "../stores/event-center";
import { useAppStore } from "../stores/appStore";
import { getLastPathSegment } from "../utils/path-utils";
import { getQueryProfile } from "../utils/query-profile";

const SQLEditor = lazy(() => import("./SQLEditor").then((module) => ({ default: module.SQLEditor })));
const TableStructure = lazy(() =>
  import("./TableStructure/TableStructure").then((module) => ({ default: module.TableStructure })),
);
const MetricsBoard = lazy(() =>
  import("./MetricsBoard/MetricsBoard").then((module) => ({ default: module.MetricsBoard })),
);

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

interface AppWorkspacePanelProps {
  tabs: Tab[];
  activeTab: Tab | null;
  isConnected: boolean;
  isConnecting: boolean;
  isSidebarCollapsed: boolean;
  sidebarWidth: number;
  leftPanel: "database" | "metrics";
  isMetricsWorkspace: boolean;
  activeConn: ConnectionConfig | undefined;
  currentDatabase: string | null;
  activeDatabaseLabel: string;
  activeQueryChrome: QueryChromeState | null;
  activeWorkspaceActivity: WorkspaceActivityState | null;
  querySessionByTab: Record<string, QueryEditorSessionState>;
  queryRunRequestByTab: Record<string, number>;
  error: string | null;
  onClearError: () => void;
  onNewQuery: () => void;
  onClearVisibleTabs: () => void;
  onRefreshWorkspace: () => Promise<void>;
  onExportDatabase: () => void;
  onOpenMetricsBoard: () => void;
  onFocusExplorerSearch: () => void;
  onOpenAISlidePanel: (prompt?: string) => void;
  onHandleShowDatabaseWorkspace: () => void;
  onHandleQueryChromeChange: (tabId: string, state: QueryChromeState) => void;
  onHandleQuerySessionChange: (tabId: string, state: QueryEditorSessionState) => void;
  onRunActiveQuery: () => void;
  showTerminalPanel: boolean;
  isExportingDatabase: boolean;
  onToggleTerminalPanel: () => void;
  onGoToLauncher: () => void;
  onToggleSidebar: () => void;
  onSetConnectionFormIntent: (intent: "connect" | "bootstrap") => void;
  onHandleMouseDown: (e: React.MouseEvent) => void;
}

function LazyPanelFallback() {
  return (
    <div className="flex items-center justify-center h-full min-h-[220px] text-sm text-[var(--text-muted)]">
      Loading workspace...
    </div>
  );
}

function LazyTerminalFallback() {
  return (
    <section
      aria-hidden={false}
      style={{
        borderTop: "1px solid rgba(0, 212, 170, 0.14)",
        background: "rgba(5, 10, 18, 0.92)",
        padding: "10px 12px",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          minHeight: 30,
          padding: "0 10px",
          borderRadius: 10,
          border: "1px solid rgba(0, 212, 170, 0.16)",
          background: "rgba(0, 212, 170, 0.05)",
          color: "var(--fintech-green)",
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        <Terminal className="w-3.5 h-3.5" />
        <span>Loading terminal...</span>
      </div>
    </section>
  );
}

export function AppWorkspacePanel({
  tabs,
  activeTab,
  isConnected,
  isConnecting,
  isSidebarCollapsed,
  sidebarWidth,
  leftPanel,
  isMetricsWorkspace,
  activeConn,
  currentDatabase,
  activeDatabaseLabel,
  activeQueryChrome,
  activeWorkspaceActivity,
  querySessionByTab,
  queryRunRequestByTab,
  error,
  onClearError,
  onNewQuery,
  onClearVisibleTabs,
  onRefreshWorkspace,
  onExportDatabase,
  onOpenMetricsBoard,
  onFocusExplorerSearch,
  onOpenAISlidePanel,
  onHandleShowDatabaseWorkspace,
  onHandleQueryChromeChange,
  onHandleQuerySessionChange,
  onRunActiveQuery,
  showTerminalPanel,
  isExportingDatabase,
  onToggleTerminalPanel,
  onGoToLauncher,
  onToggleSidebar,
  onSetConnectionFormIntent,
  onHandleMouseDown,
}: AppWorkspacePanelProps) {
  const { t, language } = useI18n();
  const terminalToggleTitle =
    language === "vi" ? "Bat/tat terminal (Ctrl+`)" : "Toggle terminal (Ctrl+`)";
  const workspaceQueryProfile = getQueryProfile(activeConn?.db_type);
  const activeDatabaseTarget =
    currentDatabase ||
    activeConn?.database ||
    getLastPathSegment(activeConn?.file_path) ||
    t("workspace.ready.currentDatabaseSelected");
  const activeEngineLabel = (activeConn?.db_type || "").toUpperCase() || "DB";
  const isWorkspaceOverview = tabs.length === 0 || !activeTab;
  const isERDiagramWorkspace = activeTab?.type === "er-diagram";
  const isDatabasePanelActive = !isERDiagramWorkspace && leftPanel === "database";
  const isMetricsPanelActive = !isERDiagramWorkspace && leftPanel === "metrics";
  const isERDiagramPanelActive = activeTab?.type === "er-diagram";

  const [loadingTimeoutExceeded, setLoadingTimeoutExceeded] = useState(false);
  const [hasMountedTerminalDock, setHasMountedTerminalDock] = useState(showTerminalPanel);
  const [showToolbarMore, setShowToolbarMore] = useState(false);
  const toolbarMoreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showToolbarMore) return;
    const handler = (e: MouseEvent) => {
      if (toolbarMoreRef.current && !toolbarMoreRef.current.contains(e.target as Node)) {
        setShowToolbarMore(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showToolbarMore]);

  useEffect(() => {
    let timeoutId: number | null = null;

    if (!isConnected && isConnecting && activeConn) {
      setLoadingTimeoutExceeded(false);
      timeoutId = window.setTimeout(() => {
        setLoadingTimeoutExceeded(true);
      }, 30000);
    } else {
      setLoadingTimeoutExceeded(false);
    }

    return () => {
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [isConnected, isConnecting, activeConn]);

  useEffect(() => {
    if (showTerminalPanel) {
      setHasMountedTerminalDock(true);
    }
  }, [showTerminalPanel]);

  // EventCenter: respond to global sidebar toggle
  useEvent("workspace-toggle-sidebar", () => {
    onToggleSidebar();
  });

  // EventCenter: respond to workspace refresh from any component
  useEvent("workspace-refresh", () => {
    onRefreshWorkspace();
  });

  const handleOpenERDiagram = () => {
    if (!activeConn?.id) return;
    const id = `er-${Date.now()}`;
    const appStore = useAppStore.getState();
    appStore.addTab({
      id,
      type: "er-diagram",
      title: "ER Diagram",
      connectionId: activeConn.id,
      database: currentDatabase || undefined,
    });
    appStore.setActiveTab(id);
  };

  const renderTabContent = () => {
    if (loadingTimeoutExceeded) {
      return (
        <WorkspaceErrorFallback
            variant="inline"
            error={new Error("Workspace connection timed out after 30 seconds.")}
          onRetry={() => {
            setLoadingTimeoutExceeded(false);
            if (activeConn?.id) {
              useAppStore.setState({ isConnecting: false });
              void useAppStore.getState().connectSavedConnection(activeConn.id);
            } else {
              onRefreshWorkspace();
            }
          }}
          onGoToLauncher={() => {
            setLoadingTimeoutExceeded(false);
            onGoToLauncher();
          }}
        />
      );
    }

    if (!isConnected && isConnecting && activeConn) {
      return (
        <div className="workspace-empty fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-primary)]">
          <div className="workspace-empty-panel workspace-connecting-panel max-w-[340px] flex flex-col items-center justify-center overflow-hidden border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl p-8 rounded-2xl mx-4 relative overflow-hidden">
            
            {/* Ambient animated glow */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[120px] h-[120px] bg-[var(--accent)]/10 rounded-full blur-[60px] animate-pulse"></div>

            <div className="workspace-empty-hero w-full flex flex-col items-center justify-center gap-6 relative z-10 m-0 p-0">
              <div className="w-14 h-14 rounded-full border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-sm flex items-center justify-center">
                <LoaderCircle className="w-6 h-6 text-[var(--accent)] animate-spin" strokeWidth={2.5} />
              </div>

              <div className="workspace-empty-copy flex flex-col items-center w-full text-center gap-1.5 m-0 p-0">
                <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-[var(--accent)] opacity-80">{t("common.loading")}</span>
                <h2 className="text-xl font-bold text-[var(--text-primary)] truncate w-full max-w-[280px]" title={activeConn.name || t("workspace.ready.connectedWorkspace")}>
                  {activeConn.name || t("workspace.ready.connectedWorkspace")}
                </h2>
                <p className="text-sm text-[var(--text-secondary)] opacity-70 truncate w-full max-w-[280px]" title={currentDatabase || activeConn.database || activeConn.host || activeConn.file_path || ""}>
                  {currentDatabase || activeConn.database || activeConn.host || activeConn.file_path || ""}
                </p>
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (!isConnected) {
      return (
        <div className="workspace-empty">
          <div className="workspace-empty-panel">
            <div className="workspace-empty-hero">
              <div className="workspace-empty-icon">
                <Database className="workspace-empty-glyph w-10 h-10" />
              </div>

              <div className="workspace-empty-copy">
                <span className="workspace-empty-kicker">{t("workspace.empty.kicker")}</span>
                <h2 className="workspace-empty-title">{t("workspace.empty.title")}</h2>
                <p className="workspace-empty-description">
                  {t("workspace.empty.description")}
                </p>
              </div>
            </div>

            <div className="workspace-empty-actions">
              <button type="button" onClick={() => onSetConnectionFormIntent("connect")} className="btn btn-primary">
                <Plus className="w-3.5 h-3.5" />
                {t("workspace.empty.newConnection")}
              </button>
              <button type="button" onClick={() => onSetConnectionFormIntent("bootstrap")} className="btn btn-secondary">
                <Database className="w-3.5 h-3.5" />
                {t("workspace.empty.createLocalDb")}
              </button>
            </div>

            <div className="workspace-empty-grid">
              <div className="workspace-empty-card">
                <span className="workspace-empty-card-kicker">{t("workspace.empty.connections")}</span>
                <strong className="workspace-empty-card-title">{t("workspace.empty.savedWorkspaces")}</strong>
                <p className="workspace-empty-card-copy">
                  {t("workspace.empty.savedWorkspacesDesc")}
                </p>
              </div>

              <div className="workspace-empty-card">
                <span className="workspace-empty-card-kicker">{t("workspace.empty.supported")}</span>
                <strong className="workspace-empty-card-title">{t("workspace.empty.primaryEngines")}</strong>
                <p className="workspace-empty-card-copy">
                  {t("workspace.empty.primaryEnginesDesc")}
                </p>
              </div>

              <div className="workspace-empty-card">
                <span className="workspace-empty-card-kicker">{t("workspace.empty.workflow")}</span>
                <strong className="workspace-empty-card-title">{t("workspace.empty.connectToQuery")}</strong>
                <p className="workspace-empty-card-copy">
                  {t("workspace.empty.connectToQueryDesc")}
                </p>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="workspace-empty workspace-ready-shell">
        <div className="workspace-empty-panel workspace-ready-panel">
          <div className="workspace-ready-header">
            <div className="workspace-ready-header-left">
              <div className="workspace-ready-icon">
                <Sparkles className="workspace-ready-glyph w-5 h-5" />
              </div>
              <div className="workspace-ready-header-copy">
                <span className="workspace-ready-kicker">{t("workspace.ready.kicker")}</span>
                <h2 className="workspace-ready-title">{t("workspace.ready.title")}</h2>
                <p className="workspace-ready-desc">{t("workspace.ready.description")}</p>
              </div>
            </div>
            <div className="workspace-ready-header-right">
              <div className="workspace-ready-meta-chip">
                <span className="workspace-ready-meta-label">{t("workspace.ready.connection")}</span>
                <strong className="workspace-ready-meta-value">{activeConn?.name || activeDatabaseLabel}</strong>
              </div>
              <div className="workspace-ready-meta-chip">
                <span className="workspace-ready-meta-label">{t("workspace.ready.database")}</span>
                <strong className="workspace-ready-meta-value">{activeDatabaseTarget}</strong>
              </div>
              <div className="workspace-ready-meta-chip">
                <span className="workspace-ready-meta-label">{t("workspace.ready.engine")}</span>
                <strong className="workspace-ready-meta-value">{activeEngineLabel}</strong>
              </div>
            </div>
          </div>

          <div className="workspace-ready-actions workspace-ready-actions--compact">
            <button type="button" className="workspace-ready-action-card" data-tone="query" onClick={onNewQuery}>
              <div className="workspace-ready-action-icon">
                {workspaceQueryProfile.surface === "command" ? (
                  <Terminal className="w-4 h-4" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
              </div>
              <div className="workspace-ready-action-body">
                <span className="workspace-ready-action-title">
                  {workspaceQueryProfile.surface === "command"
                    ? t("workspace.ready.commandTitle")
                    : t("workspace.ready.queryTitle")}
                </span>
                <span className="workspace-ready-action-kicker">
                  {workspaceQueryProfile.surface === "command"
                    ? t("workspace.ready.commandTerminal")
                    : t("workspace.ready.sqlEditor")}
                </span>
              </div>
              <kbd className="kbd">Ctrl+N</kbd>
            </button>

            <button type="button" className="workspace-ready-action-card" data-tone="explorer" onClick={onFocusExplorerSearch}>
              <div className="workspace-ready-action-icon"><Search className="w-4 h-4" /></div>
              <div className="workspace-ready-action-body">
                <span className="workspace-ready-action-title">{t("workspace.ready.explorerTitle")}</span>
                <span className="workspace-ready-action-kicker">{t("workspace.ready.explorerKicker")}</span>
              </div>
              <kbd className="kbd">Ctrl+B</kbd>
            </button>

            <button type="button" className="workspace-ready-action-card" data-tone="ai" onClick={() => onOpenAISlidePanel()}>
              <div className="workspace-ready-action-icon"><Sparkles className="w-4 h-4" /></div>
              <div className="workspace-ready-action-body">
                <span className="workspace-ready-action-title">{t("workspace.ready.aiTitle")}</span>
                <span className="workspace-ready-action-kicker">{t("workspace.ready.aiKicker")}</span>
              </div>
              <kbd className="kbd">Ctrl+Shift+P</kbd>
            </button>

            <button
              type="button"
              className="workspace-ready-action-card"
              data-tone="diagram"
              onClick={handleOpenERDiagram}
            >
              <div className="workspace-ready-action-icon"><GitBranch className="w-4 h-4" /></div>
              <div className="workspace-ready-action-body">
                <span className="workspace-ready-action-title">ER Diagram</span>
                <span className="workspace-ready-action-kicker">{t("workspace.ready.database")}</span>
              </div>
              <kbd className="kbd">Ctrl+E</kbd>
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderSingleTab = (tab: Tab, isActive: boolean) => {
    switch (tab.type) {
      case "query":
        return (
          <ErrorBoundary>
            <Suspense fallback={<LazyPanelFallback />}>
              <SQLEditor
                key={tab.id}
                connectionId={tab.connectionId}
                initialContent={tab.content || ""}
                tabId={tab.id}
                initialState={querySessionByTab[tab.id]}
                runRequestNonce={queryRunRequestByTab[tab.id] ?? 0}
                onChromeChange={(state) => onHandleQueryChromeChange(tab.id, state)}
                onStateChange={(state) => onHandleQuerySessionChange(tab.id, state)}
              />
            </Suspense>
          </ErrorBoundary>
        );
      case "table":
        return (
          <ErrorBoundary>
            <Suspense fallback={<LazyPanelFallback />}>
              <DataGrid
                key={tab.id}
                connectionId={tab.connectionId}
                tableName={tab.tableName}
                database={tab.database}
                isActive={isActive}
              />
            </Suspense>
          </ErrorBoundary>
        );
      case "structure":
        return (
          <ErrorBoundary>
            <Suspense fallback={<LazyPanelFallback />}>
              <TableStructure
                key={tab.id}
                connectionId={tab.connectionId}
                tableName={tab.tableName || ""}
                database={tab.database}
                isActive={isActive}
                structureFocusSection={tab.structureFocusSection}
                structureFocusColumn={tab.structureFocusColumn}
                structureFocusToken={tab.structureFocusToken}
              />
            </Suspense>
          </ErrorBoundary>
        );
      case "metrics":
        return (
          <ErrorBoundary>
            <Suspense fallback={<LazyPanelFallback />}>
              <MetricsBoard
                key={tab.id}
                connectionId={tab.connectionId}
                database={tab.database}
                tabId={tab.id}
                boardId={tab.metricsBoardId}
                integratedSidebar={false}
              />
            </Suspense>
          </ErrorBoundary>
        );
      case "er-diagram":
        return (
          <ErrorBoundary>
            <Suspense fallback={<LazyPanelFallback />}>
              <ERDiagram
                key={tab.id}
                connectionId={tab.connectionId}
                database={tab.database}
              />
            </Suspense>
          </ErrorBoundary>
        );
      default:
        return null;
    }
  };

  const sidebarNavItems = [
    {
      key: "database",
      icon: FolderTree,
      label: t("sidebar.dbShort"),
      title: t("sidebar.databaseExplorer"),
      active: isDatabasePanelActive,
      onClick: onHandleShowDatabaseWorkspace,
      disabled: !isConnected,
    },
    {
      key: "erd",
      icon: GitBranch,
      label: t("sidebar.erdShort"),
      title: t("sidebar.erdDiagram"),
      active: isERDiagramPanelActive,
      onClick: handleOpenERDiagram,
      disabled: !isConnected || !activeConn?.id,
    },
    {
      key: "metrics",
      icon: BarChart3,
      label: t("sidebar.metricsShort"),
      title: t("sidebar.metricsBoards"),
      active: isMetricsPanelActive,
      onClick: onOpenMetricsBoard,
      disabled: !isConnected,
    },
  ] as const;

  // Single source of truth for the sidebar navigation rail. `compact` (collapsed
  // sidebar) hides the text labels but keeps the exact same item set, order and
  // actions as the expanded rail so the two states never drift apart.
  const renderSidebarNav = (compact: boolean) => (
    <div className={compact ? "workspace-sidebar-rail workspace-sidebar-rail--compact" : "workspace-sidebar-rail"}>
      {sidebarNavItems.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            type="button"
            className={`workspace-sidebar-rail-btn ${item.active ? "active" : ""}`}
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
            }}
            title={item.title}
            disabled={item.disabled}
          >
            <Icon className="w-3.5 h-3.5" />
            <span className="sr-only">{item.label}</span>
          </button>
        );
      })}

      <div className="workspace-sidebar-rail-spacer" />

      <button
        type="button"
        className="workspace-sidebar-rail-btn"
        onClick={() => onSetConnectionFormIntent("connect")}
        title={t("sidebar.newConnection")}
      >
        <Plus className="w-3.5 h-3.5" />
        <span className="sr-only">{t("sidebar.newConnection")}</span>
      </button>

      <button
        type="button"
        className="workspace-sidebar-rail-btn"
        onClick={onToggleSidebar}
        title={compact ? t("sidebar.expandSidebar") : t("titlebar.collapseSidebar")}
      >
        <PanelRightClose className={`w-3.5 h-3.5 ${compact ? "rotate-180" : ""}`} />
        <span className="sr-only">{t("titlebar.collapseSidebar")}</span>
      </button>
    </div>
  );

  return (
    <>
      {error && (
        <div className="error-bar">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={onClearError} className="error-bar-close">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="main-container">
        <aside
          className={`sidebar ${isSidebarCollapsed ? "sidebar-collapsed" : ""} ${isERDiagramWorkspace ? "sidebar-er-focus" : ""}`}
          style={{ width: isSidebarCollapsed ? 64 : isERDiagramWorkspace ? 72 : sidebarWidth }}
        >
          {isSidebarCollapsed ? (
            renderSidebarNav(true)
          ) : (
            <div className={`workspace-sidebar-shell ${isERDiagramWorkspace ? "workspace-sidebar-shell--rail-only" : ""}`}>
              {renderSidebarNav(false)}

              {!isERDiagramWorkspace && (
                <div className="workspace-sidebar-panel">
                  <ErrorBoundary>
                    {leftPanel === "metrics" ? (
                      <MetricsSidebar
                        connectionId={activeConn?.id || ""}
                        database={currentDatabase || undefined}
                      />
                    ) : (
                      <Sidebar />
                    )}
                  </ErrorBoundary>
                </div>
              )}
            </div>
          )}
        </aside>

        {!isERDiagramWorkspace && !isSidebarCollapsed && (
          <div className="resize-handle" onMouseDown={onHandleMouseDown}>
            <div className="resize-handle-line" />
          </div>
        )}

        <main className="main-content">
          <div className="workspace-toolbar">
            <div className="workspace-toolbar-main">
              <span className="workspace-toolbar-title" title={activeTab?.title || undefined}>
                {activeTab?.title || (isConnected ? t("workspace.readyForQueries") : t("titlebar.noActiveConnection"))}
              </span>
              {isConnected && activeConn && (
                <span className="workspace-toolbar-chip">
                  {activeConn.name || activeConn.host}
                  {activeDatabaseLabel ? ` / ${activeDatabaseLabel}` : ""}
                </span>
              )}
              {activeQueryChrome?.executionTimeMs !== undefined && (
                <div className="workspace-toolbar-status">
                  <span className="workspace-toolbar-status-pill success">{t("workspace.status.success")}</span>
                  <span className="workspace-toolbar-status-pill">
                    {activeQueryChrome.executionTimeMs}ms
                  </span>
                  {typeof activeQueryChrome.rowCount === "number" && activeQueryChrome.rowCount > 0 && (
                    <span className="workspace-toolbar-status-pill">
                      {t("workspace.status.rows", { count: activeQueryChrome.rowCount })}
                    </span>
                  )}
                  {typeof activeQueryChrome.affectedRows === "number" && activeQueryChrome.affectedRows > 0 && (
                    <span className="workspace-toolbar-status-pill warning">
                      {t("workspace.status.affected", { count: activeQueryChrome.affectedRows })}
                    </span>
                  )}
                  {typeof activeQueryChrome.queryCount === "number" && activeQueryChrome.queryCount > 1 && (
                    <span className="workspace-toolbar-status-pill">
                      {t("workspace.status.batch", { count: activeQueryChrome.queryCount })}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="workspace-toolbar-actions">
              {isConnected && (
                <>
                  {!isMetricsWorkspace && (
                    <button
                      type="button"
                      onClick={onNewQuery}
                      className="toolbar-btn primary"
                      title={t("toolbar.newQueryShortcut")}
                    >
                      {workspaceQueryProfile.surface === "command" ? (
                        <Terminal className="w-3.5 h-3.5" />
                      ) : (
                        <Plus className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {workspaceQueryProfile.surface === "command"
                          ? t("workspace.ready.commandLink")
                          : t("toolbar.newQuery")}
                      </span>
                    </button>
                  )}

                  <div className="workspace-toolbar-utility">
                    <button
                      type="button"
                      onClick={onToggleTerminalPanel}
                      className={`toolbar-btn icon-only ${showTerminalPanel ? "is-active" : ""}`}
                      title={terminalToggleTitle}
                    >
                      <Terminal className="w-3.5 h-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={() => onOpenAISlidePanel()}
                      className="toolbar-btn icon-only"
                      title={t("toolbar.askAiShortcut")}
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                    </button>

                    <div className="workspace-toolbar-more" ref={toolbarMoreRef}>
                      <button
                        type="button"
                        onClick={() => setShowToolbarMore((v) => !v)}
                        className={`toolbar-btn icon-only ${showToolbarMore ? "is-active" : ""}`}
                        title={t("toolbar.moreActions")}
                        aria-haspopup="menu"
                        aria-expanded={showToolbarMore}
                      >
                        <MoreHorizontal className="w-3.5 h-3.5" />
                      </button>

                      {showToolbarMore && (
                        <div className="workspace-toolbar-more-menu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            className="workspace-toolbar-more-item"
                            onClick={() => {
                              setShowToolbarMore(false);
                              void onRefreshWorkspace();
                            }}
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>{t("toolbar.refreshWorkspace")}</span>
                          </button>

                          <button
                            type="button"
                            role="menuitem"
                            className="workspace-toolbar-more-item"
                            onClick={() => {
                              setShowToolbarMore(false);
                              onExportDatabase();
                            }}
                            disabled={!isConnected || isExportingDatabase}
                          >
                            {isExportingDatabase ? (
                              <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Download className="w-3.5 h-3.5" />
                            )}
                            <span>{t("toolbar.exportDatabase")}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          <TabBar
            queryChrome={activeQueryChrome}
            onRunActiveQuery={onRunActiveQuery}
            onClearVisibleTabs={onClearVisibleTabs}
          />

          <div className={`tab-content ${isWorkspaceOverview ? "is-workspace-overview" : ""}`}>
            {isWorkspaceOverview ? (
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

          {(showTerminalPanel || hasMountedTerminalDock) && (
            <ErrorBoundary>
              <Suspense fallback={showTerminalPanel ? <LazyTerminalFallback /> : null}>
                <TerminalDock
                  isOpen={showTerminalPanel}
                  onClose={onToggleTerminalPanel}
                />
              </Suspense>
            </ErrorBoundary>
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
              {activeWorkspaceActivity ? ` | ${activeWorkspaceActivity.label} ${activeWorkspaceActivity.durationMs}ms` : ""}
            </span>
          )}
        </div>

        <div className="statusbar-right">
          <span className="statusbar-shortcuts">
            <kbd className="kbd">Ctrl+N</kbd>
            <kbd className="kbd">Ctrl+B</kbd>
            <kbd className="kbd">Ctrl+`</kbd>
            <kbd className="kbd">Ctrl+Shift+P</kbd>
          </span>
          <span>TableR v0.1.4</span>
        </div>
      </footer>
    </>
  );
}


