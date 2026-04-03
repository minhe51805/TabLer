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
  Database,
  AlertCircle,
  LoaderCircle,
} from "lucide-react";
import { lazy, Suspense } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { MetricsSidebar } from "./MetricsSidebar/MetricsSidebar";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import ERDiagram from "./ERDiagram/ERDiagram";
import { TerminalDock } from "./TerminalDock/TerminalDock";
import type { Tab } from "../types";
import type { ConnectionConfig } from "../types/database";
import type { QueryEditorSessionState } from "./SQLEditor";
import { useI18n } from "../i18n";
import { useEvent } from "../stores/event-center";
import { useAppStore } from "../stores/appStore";
import { getLastPathSegment } from "../utils/path-utils";
import { getQueryProfile } from "../utils/query-profile";

const SQLEditor = lazy(() => import("./SQLEditor").then((module) => ({ default: module.SQLEditor })));
const DataGrid = lazy(() => import("./DataGrid").then((module) => ({ default: module.DataGrid })));
const TableStructure = lazy(() => import("./TableStructure").then((module) => ({ default: module.TableStructure })));
const MetricsBoard = lazy(() => import("./MetricsBoard").then((module) => ({ default: module.MetricsBoard })));

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
  onToggleSidebar,
  onSetConnectionFormIntent,
  onHandleMouseDown,
}: AppWorkspacePanelProps) {
  const { t, language } = useI18n();
  const terminalToggleTitle =
    language === "vi" ? "Bat/tat terminal (Ctrl+`)" : "Toggle terminal (Ctrl+`)";
  const connections = useAppStore((state) => state.connections);
  const activeTabConnection = activeTab
    ? connections.find((connection) => connection.id === activeTab.connectionId)
    : activeConn;
  const activeQueryProfile = getQueryProfile(activeTabConnection?.db_type);
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
    if (!isConnected && isConnecting && activeConn) {
      return (
        <div className="workspace-empty">
          <div className="workspace-empty-panel workspace-connecting-panel">
            <div className="workspace-empty-hero">
              <div className="workspace-empty-icon workspace-ready-icon">
                <LoaderCircle className="workspace-empty-glyph w-10 h-10 animate-spin" />
              </div>

              <div className="workspace-empty-copy">
                <span className="workspace-empty-kicker">{t("common.loading")}</span>
                <h2 className="workspace-empty-title">
                  {activeConn.name || t("workspace.ready.connectedWorkspace")}
                </h2>
                <p className="workspace-empty-description">
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
              <button onClick={() => onSetConnectionFormIntent("connect")} className="btn btn-primary">
                <Plus className="w-3.5 h-3.5" />
                {t("workspace.empty.newConnection")}
              </button>
              <button onClick={() => onSetConnectionFormIntent("bootstrap")} className="btn btn-secondary">
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

          <div className="workspace-ready-actions">
            <button type="button" className="workspace-ready-action-card" data-tone="query" onClick={onNewQuery}>
              <div className="workspace-ready-action-top">
                <div className="workspace-ready-action-icon">
                  {workspaceQueryProfile.surface === "command" ? (
                    <Terminal className="w-4 h-4" />
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                </div>
                <div className="workspace-ready-action-body">
                  <span className="workspace-ready-action-kicker">
                    {workspaceQueryProfile.surface === "command"
                      ? t("workspace.ready.commandTerminal")
                      : t("workspace.ready.sqlEditor")}
                  </span>
                  <span className="workspace-ready-action-title">
                    {workspaceQueryProfile.surface === "command"
                      ? t("workspace.ready.commandTitle")
                      : t("workspace.ready.queryTitle")}
                  </span>
                </div>
              </div>
              <span className="workspace-ready-action-description">
                {workspaceQueryProfile.surface === "command"
                  ? t("workspace.ready.commandDescription", {
                      surface: workspaceQueryProfile.surfaceLabel,
                    })
                  : t("workspace.ready.queryDescription")}
              </span>
              <div className="workspace-ready-action-foot">
                <kbd className="kbd">Ctrl+N</kbd>
                <span className="workspace-ready-action-link">
                  {workspaceQueryProfile.surface === "command"
                    ? t("workspace.ready.commandLink")
                    : t("workspace.ready.queryLink")}
                </span>
              </div>
            </button>

            <button type="button" className="workspace-ready-action-card" data-tone="explorer" onClick={onFocusExplorerSearch}>
              <div className="workspace-ready-action-top">
                <div className="workspace-ready-action-icon"><Search className="w-4 h-4" /></div>
                <div className="workspace-ready-action-body">
                  <span className="workspace-ready-action-kicker">{t("workspace.ready.explorerKicker")}</span>
                  <span className="workspace-ready-action-title">{t("workspace.ready.explorerTitle")}</span>
                </div>
              </div>
              <span className="workspace-ready-action-description">{t("workspace.ready.explorerDescription")}</span>
              <div className="workspace-ready-action-foot">
                <kbd className="kbd">Ctrl+B</kbd>
                <span className="workspace-ready-action-link">{t("workspace.ready.explorerLink")}</span>
              </div>
            </button>

            <button type="button" className="workspace-ready-action-card" data-tone="ai" onClick={() => onOpenAISlidePanel()}>
              <div className="workspace-ready-action-top">
                <div className="workspace-ready-action-icon"><Sparkles className="w-4 h-4" /></div>
                <div className="workspace-ready-action-body">
                  <span className="workspace-ready-action-kicker">{t("workspace.ready.aiKicker")}</span>
                  <span className="workspace-ready-action-title">{t("workspace.ready.aiTitle")}</span>
                </div>
              </div>
              <span className="workspace-ready-action-description">{t("workspace.ready.aiDescription")}</span>
              <div className="workspace-ready-action-foot">
                <kbd className="kbd">Ctrl+Shift+P</kbd>
                <span className="workspace-ready-action-link">{t("workspace.ready.aiLink")}</span>
              </div>
            </button>

            <button
              type="button"
              className="workspace-ready-action-card"
              data-tone="diagram"
              onClick={handleOpenERDiagram}
            >
              <div className="workspace-ready-action-top">
                <div className="workspace-ready-action-icon"><GitBranch className="w-4 h-4" /></div>
                <div className="workspace-ready-action-body">
                  <span className="workspace-ready-action-kicker">{t("workspace.ready.database")}</span>
                  <span className="workspace-ready-action-title">ER Diagram</span>
                </div>
              </div>
              <span className="workspace-ready-action-description">
                Visualize tables and relationships without leaving the current workspace.
              </span>
              <div className="workspace-ready-action-foot">
                <kbd className="kbd">Ctrl+E</kbd>
                <span className="workspace-ready-action-link">Open diagram</span>
              </div>
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
            <ERDiagram
              key={tab.id}
              connectionId={tab.connectionId}
              database={tab.database}
            />
          </ErrorBoundary>
        );
      default:
        return null;
    }
  };

  const renderSidebarRail = () => (
    <div className="sidebar-rail">
      <button
        type="button"
        className={`sidebar-rail-btn ${isDatabasePanelActive ? "active" : ""}`}
        onClick={() => {
          if (!isConnected) return;
          onHandleShowDatabaseWorkspace();
        }}
        title={t("sidebar.explorer")}
        disabled={!isConnected}
      >
        <FolderTree className="w-3.5 h-3.5" />
      </button>

      <button
        type="button"
        className={`sidebar-rail-btn ${isMetricsPanelActive ? "active" : ""}`}
        onClick={() => {
          if (!isConnected) return;
          onOpenMetricsBoard();
        }}
        title={t("sidebar.metrics")}
        disabled={!isConnected}
      >
        <BarChart3 className="w-3.5 h-3.5" />
      </button>

      <button
        type="button"
        className={`sidebar-rail-btn ${isERDiagramPanelActive ? "active" : ""}`}
        onClick={handleOpenERDiagram}
        title={t("sidebar.erd")}
        disabled={!isConnected || !activeConn?.id}
      >
        <GitBranch className="w-3.5 h-3.5" />
      </button>

      <button
        type="button"
        className="sidebar-rail-btn"
        onClick={() => onSetConnectionFormIntent("connect")}
        title={t("sidebar.newConnection")}
      >
        <Plus className="w-3.5 h-3.5" />
      </button>

      <div className="sidebar-rail-spacer" />

      <button
        type="button"
        className="sidebar-rail-btn"
        onClick={onToggleSidebar}
        title={t("sidebar.expandSidebar")}
      >
        <PanelRightClose className="w-3.5 h-3.5 rotate-180" />
      </button>
    </div>
  );

  return (
    <>
      {error && (
        <div className="error-bar">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={onClearError} className="error-bar-close">
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
            renderSidebarRail()
          ) : (
            <div className={`workspace-sidebar-shell ${isERDiagramWorkspace ? "workspace-sidebar-shell--rail-only" : ""}`}>
              <div className="workspace-sidebar-rail">
                <button
                  type="button"
                  className={`workspace-sidebar-rail-btn ${isDatabasePanelActive ? "active" : ""}`}
                  onClick={onHandleShowDatabaseWorkspace}
                  title={t("sidebar.databaseExplorer")}
                >
                  <FolderTree className="w-3.5 h-3.5" />
                  <span>{t("sidebar.dbShort")}</span>
                </button>
                <button
                  type="button"
                  className={`workspace-sidebar-rail-btn ${isERDiagramPanelActive ? "active" : ""}`}
                  onClick={handleOpenERDiagram}
                  title={t("sidebar.erdDiagram")}
                >
                  <GitBranch className="w-3.5 h-3.5" />
                  <span>{t("sidebar.erdShort")}</span>
                </button>
                <button
                  type="button"
                  className={`workspace-sidebar-rail-btn ${isMetricsPanelActive ? "active" : ""}`}
                  onClick={onOpenMetricsBoard}
                  title={t("sidebar.metricsBoards")}
                >
                  <BarChart3 className="w-3.5 h-3.5" />
                  <span>{t("sidebar.metricsShort")}</span>
                </button>
              </div>

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
              <div className="workspace-toolbar-topline">
                <span className="workspace-toolbar-kicker">
                  {activeTab
                    ? activeTab.type === "query"
                      ? activeQueryProfile.surface === "command"
                        ? t("workspace.kicker.command")
                        : t("workspace.kicker.sql")
                      : activeTab.type === "table"
                        ? t("workspace.kicker.table")
                        : activeTab.type === "structure"
                          ? t("workspace.kicker.structure")
                          : t("workspace.kicker.metrics")
                    : t("workspace.kicker.default")}
                </span>
                {isConnected && activeConn && (
                  <span className="workspace-toolbar-chip">
                    {activeConn.name || activeConn.host}
                    {activeDatabaseLabel ? ` / ${activeDatabaseLabel}` : ""}
                  </span>
                )}
              </div>

              <div className="workspace-toolbar-title-row">
                <span className="workspace-toolbar-title">
                  {activeTab?.title || (isConnected ? t("workspace.readyForQueries") : t("titlebar.noActiveConnection"))}
                </span>
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
            </div>

            <div className="workspace-toolbar-actions">
              {isConnected && (
                <>
                  {!isMetricsWorkspace && (
                    <button
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
                      onClick={() => void onRefreshWorkspace()}
                      className="toolbar-btn icon-only"
                      title={t("toolbar.refreshWorkspace")}
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>

                    <button
                      onClick={onExportDatabase}
                      className="toolbar-btn icon-only"
                      title={t("toolbar.exportDatabase")}
                      disabled={!isConnected || isExportingDatabase}
                    >
                      {isExportingDatabase ? (
                        <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Download className="w-3.5 h-3.5" />
                      )}
                    </button>

                    <button
                      onClick={onToggleTerminalPanel}
                      className={`toolbar-btn icon-only ${showTerminalPanel ? "is-active" : ""}`}
                      title={terminalToggleTitle}
                    >
                      <Terminal className="w-3.5 h-3.5" />
                    </button>

                    <button
                      onClick={() => onOpenAISlidePanel()}
                      className="toolbar-btn icon-only"
                      title={t("toolbar.askAiShortcut")}
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

          <TerminalDock
            isOpen={showTerminalPanel}
            onClose={onToggleTerminalPanel}
          />
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
          <span>TableR v0.1.0</span>
        </div>
      </footer>
    </>
  );
}
