import {
  FolderTree,
  BarChart3,
  Plus,
  GitBranch,
  ArrowUpRight,
  X,
  RotateCcw,
  Search,
  Sparkles,
  Cable,
  PanelRightClose,
  Database,
  AlertCircle,
  LoaderCircle,
} from "lucide-react";
import { lazy, Suspense } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { ConnectionList } from "./ConnectionList";
import { MetricsSidebar } from "./MetricsSidebar/MetricsSidebar";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import type { Tab } from "../types";
import type { ConnectionConfig } from "../types/database";
import type { QueryEditorSessionState } from "./SQLEditor";
import { useI18n } from "../i18n";
import { useEvent } from "../stores/event-center";
import { useAppStore } from "../stores/appStore";

const SQLEditor = lazy(() => import("./SQLEditor").then((module) => ({ default: module.SQLEditor })));
const DataGrid = lazy(() => import("./DataGrid").then((module) => ({ default: module.DataGrid })));
const TableStructure = lazy(() => import("./TableStructure").then((module) => ({ default: module.TableStructure })));
const MetricsBoard = lazy(() => import("./MetricsBoard").then((module) => ({ default: module.MetricsBoard })));
const ERDiagram = lazy(() => import("./ERDiagram").then((module) => ({ default: module.ERDiagram })));

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
  leftPanel: "connections" | "database" | "metrics";
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
  onOpenMetricsBoard: () => void;
  onOpenConnectionForm: (intent: "connect" | "bootstrap") => void;
  onFocusExplorerSearch: () => void;
  onOpenAISlidePanel: (prompt?: string) => void;
  onHandleShowDatabaseWorkspace: () => void;
  onHandleQueryChromeChange: (tabId: string, state: QueryChromeState) => void;
  onHandleQuerySessionChange: (tabId: string, state: QueryEditorSessionState) => void;
  onRunActiveQuery: () => void;
  onToggleSidebar: () => void;
  onSetIsSidebarCollapsed: (value: boolean) => void;
  onSetLeftPanel: (panel: "connections" | "database" | "metrics") => void;
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

function getLastPathSegment(value?: string | null) {
  if (!value) return "";
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
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
  onOpenMetricsBoard,
  onOpenConnectionForm,
  onFocusExplorerSearch,
  onOpenAISlidePanel,
  onHandleShowDatabaseWorkspace,
  onHandleQueryChromeChange,
  onHandleQuerySessionChange,
  onRunActiveQuery,
  onToggleSidebar,
  onSetIsSidebarCollapsed,
  onSetLeftPanel,
  onSetConnectionFormIntent,
  onHandleMouseDown,
}: AppWorkspacePanelProps) {
  const { t } = useI18n();
  const activeDatabaseTarget =
    currentDatabase ||
    activeConn?.database ||
    getLastPathSegment(activeConn?.file_path) ||
    t("workspace.ready.currentDatabaseSelected");
  const activeEngineLabel = (activeConn?.db_type || "").toUpperCase() || "DB";
  const isWorkspaceOverview = tabs.length === 0 || !activeTab;

  // EventCenter: respond to global sidebar toggle
  useEvent("workspace-toggle-sidebar", () => {
    onToggleSidebar();
  });

  // EventCenter: respond to workspace refresh from any component
  useEvent("workspace-refresh", () => {
    onRefreshWorkspace();
  });

  const renderTabContent = () => {
    if (!isConnected && isConnecting && activeConn) {
      return (
        <div className="workspace-empty">
          <div className="workspace-empty-panel workspace-connecting-panel">
            <div className="workspace-empty-hero">
              <div className="workspace-empty-icon workspace-ready-icon">
                <LoaderCircle className="w-10 h-10 text-[var(--accent)] animate-spin" />
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
                <Database className="w-10 h-10 text-[var(--accent)]" />
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
          <div className="workspace-ready-hero">
            <div className="workspace-empty-hero">
              <div className="workspace-empty-icon workspace-ready-icon">
                <Sparkles className="w-10 h-10 text-[var(--accent)]" />
              </div>

              <div className="workspace-empty-copy">
                <span className="workspace-empty-kicker">{t("workspace.ready.kicker")}</span>
                <h2 className="workspace-empty-title">{t("workspace.ready.title")}</h2>
                <p className="workspace-empty-description">
                  {t("workspace.ready.description")}
                </p>
              </div>
            </div>

            <div className="workspace-ready-context">
              <div className="workspace-ready-context-copy">
                <span className="workspace-ready-context-label">{t("workspace.ready.activeSession")}</span>
                <strong className="workspace-ready-context-title">
                  {activeConn?.name || t("workspace.ready.connectedWorkspace")}
                </strong>
              </div>

              <div className="workspace-ready-context-grid">
                <div className="workspace-ready-context-stat">
                  <span className="workspace-ready-context-stat-label">{t("workspace.ready.database")}</span>
                  <strong className="workspace-ready-context-stat-value">{activeDatabaseTarget}</strong>
                </div>
                <div className="workspace-ready-context-stat">
                  <span className="workspace-ready-context-stat-label">{t("workspace.ready.engine")}</span>
                  <strong className="workspace-ready-context-stat-value">{activeEngineLabel}</strong>
                </div>
              </div>

              <div className="workspace-ready-shortcut-group">
                <div className="workspace-ready-shortcut-row">
                  <span className="workspace-ready-shortcut-pill">
                    <kbd className="kbd">Ctrl+N</kbd>
                    <span>{t("common.query").toLowerCase()}</span>
                  </span>
                  <span className="workspace-ready-shortcut-pill">
                    <kbd className="kbd">Ctrl+B</kbd>
                    <span>{t("common.explorer").toLowerCase()}</span>
                  </span>
                  <span className="workspace-ready-shortcut-pill">
                    <kbd className="kbd">Ctrl+Shift+P</kbd>
                    <span>AI</span>
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="workspace-ready-actions">
            <button
              type="button"
              className="workspace-ready-action-card"
              data-tone="query"
              onClick={onNewQuery}
            >
              <div className="workspace-ready-action-top">
                <div className="workspace-ready-action-icon">
                  <Plus className="w-4 h-4" />
                </div>
                <span className="workspace-ready-action-kicker">{t("workspace.ready.sqlEditor")}</span>
              </div>
              <div className="workspace-ready-action-body">
                <strong className="workspace-ready-action-title">{t("workspace.ready.queryTitle")}</strong>
                <p className="workspace-ready-action-description">
                  {t("workspace.ready.queryDescription")}
                </p>
              </div>
              <div className="workspace-ready-action-foot">
                <kbd className="kbd">Ctrl+N</kbd>
                <span className="workspace-ready-action-link">
                  {t("workspace.ready.queryLink")}
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </span>
              </div>
            </button>

            <button
              type="button"
              className="workspace-ready-action-card"
              data-tone="explorer"
              onClick={onFocusExplorerSearch}
            >
              <div className="workspace-ready-action-top">
                <div className="workspace-ready-action-icon">
                  <Search className="w-4 h-4" />
                </div>
                <span className="workspace-ready-action-kicker">{t("workspace.ready.explorerKicker")}</span>
              </div>
              <div className="workspace-ready-action-body">
                <strong className="workspace-ready-action-title">{t("workspace.ready.explorerTitle")}</strong>
                <p className="workspace-ready-action-description">
                  {t("workspace.ready.explorerDescription")}
                </p>
              </div>
              <div className="workspace-ready-action-foot">
                <kbd className="kbd">Ctrl+B</kbd>
                <span className="workspace-ready-action-link">
                  {t("workspace.ready.explorerLink")}
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </span>
              </div>
            </button>

            <button
              type="button"
              className="workspace-ready-action-card"
              data-tone="ai"
              onClick={() => onOpenAISlidePanel()}
            >
              <div className="workspace-ready-action-top">
                <div className="workspace-ready-action-icon">
                  <Sparkles className="w-4 h-4" />
                </div>
                <span className="workspace-ready-action-kicker">{t("workspace.ready.aiKicker")}</span>
              </div>
              <div className="workspace-ready-action-body">
                <strong className="workspace-ready-action-title">{t("workspace.ready.aiTitle")}</strong>
                <p className="workspace-ready-action-description">
                  {t("workspace.ready.aiDescription")}
                </p>
              </div>
              <div className="workspace-ready-action-foot">
                <kbd className="kbd">Ctrl+Shift+P</kbd>
                <span className="workspace-ready-action-link">
                  {t("workspace.ready.aiLink")}
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </span>
              </div>
            </button>

            <button
              type="button"
              className="workspace-ready-action-card"
              data-tone="diagram"
              onClick={() => {
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
              }}
            >
              <div className="workspace-ready-action-top">
                <div className="workspace-ready-action-icon">
                  <GitBranch className="w-4 h-4" />
                </div>
                <span className="workspace-ready-action-kicker">database</span>
              </div>
              <div className="workspace-ready-action-body">
                <strong className="workspace-ready-action-title">ER Diagram</strong>
                <p className="workspace-ready-action-description">
                  Visualize database schema and relationships
                </p>
              </div>
              <div className="workspace-ready-action-foot">
                <kbd className="kbd">Ctrl+E</kbd>
                <span className="workspace-ready-action-link">
                  open diagram
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </span>
              </div>
            </button>
          </div>

          <div className="workspace-ready-support">
            <div className="workspace-ready-support-card is-compact">
              <span className="workspace-ready-support-kicker">{t("workspace.ready.flowKicker")}</span>
              <strong className="workspace-ready-support-title">{t("workspace.ready.flowTitle")}</strong>
              <div className="workspace-ready-chip-list">
                <span className="workspace-ready-chip">{t("common.query")}</span>
                <span className="workspace-ready-chip">{t("common.explorer")}</span>
                <span className="workspace-ready-chip">AI</span>
              </div>
            </div>

            <div className="workspace-ready-support-card is-compact">
              <span className="workspace-ready-support-kicker">{t("workspace.ready.targetKicker")}</span>
              <strong className="workspace-ready-support-title">{t("workspace.ready.targetTitle")}</strong>
              <div className="workspace-ready-chip-list workspace-ready-chip-list-metrics">
                <span className="workspace-ready-chip workspace-ready-chip-metric">
                  <span className="workspace-ready-chip-metric-label">{t("workspace.ready.connection")}</span>
                  <strong className="workspace-ready-chip-metric-value">
                    {activeConn?.name || t("workspace.ready.connectedWorkspace")}
                  </strong>
                </span>
                <span className="workspace-ready-chip workspace-ready-chip-metric">
                  <span className="workspace-ready-chip-metric-label">{t("workspace.ready.database")}</span>
                  <strong className="workspace-ready-chip-metric-value">
                    {activeDatabaseTarget || t("workspace.ready.selectedTarget")}
                  </strong>
                </span>
                <span className="workspace-ready-chip workspace-ready-chip-metric">
                  <span className="workspace-ready-chip-metric-label">{t("workspace.ready.engine")}</span>
                  <strong className="workspace-ready-chip-metric-value">
                    {activeEngineLabel}
                  </strong>
                </span>
              </div>
            </div>

            <div className="workspace-ready-support-card is-compact">
              <span className="workspace-ready-support-kicker">{t("workspace.ready.safetyKicker")}</span>
              <strong className="workspace-ready-support-title">{t("workspace.ready.safetyTitle")}</strong>
              <div className="workspace-ready-chip-list">
                <span className="workspace-ready-chip">{t("workspace.ready.safetyTitle")}</span>
                <span className="workspace-ready-chip">{t("toolbar.refreshWorkspace")}</span>
                <span className="workspace-ready-chip">AI</span>
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

  const renderSidebarRail = () => (
    <div className="sidebar-rail">
      <button
        type="button"
        className={`sidebar-rail-btn ${leftPanel === "connections" ? "active" : ""}`}
        onClick={() => {
          onSetIsSidebarCollapsed(false);
          onSetLeftPanel("connections");
        }}
        title={t("sidebar.connections")}
      >
        <Cable className="w-4 h-4" />
      </button>

      <button
        type="button"
        className={`sidebar-rail-btn ${leftPanel === "database" ? "active" : ""}`}
        onClick={() => {
          if (!isConnected) return;
          onHandleShowDatabaseWorkspace();
        }}
        title={t("sidebar.explorer")}
        disabled={!isConnected}
      >
        <FolderTree className="w-4 h-4" />
      </button>

      <button
        type="button"
        className={`sidebar-rail-btn ${leftPanel === "metrics" ? "active" : ""}`}
        onClick={() => {
          if (!isConnected) return;
          onOpenMetricsBoard();
        }}
        title={t("sidebar.metrics")}
        disabled={!isConnected}
      >
        <BarChart3 className="w-4 h-4" />
      </button>

      <button
        type="button"
        className="sidebar-rail-btn"
        onClick={() => onSetConnectionFormIntent("connect")}
        title={t("sidebar.newConnection")}
      >
        <Plus className="w-4 h-4" />
      </button>

      <div className="sidebar-rail-spacer" />

      <button
        type="button"
        className="sidebar-rail-btn"
        onClick={onToggleSidebar}
        title={t("sidebar.expandSidebar")}
      >
        <PanelRightClose className="w-4 h-4 rotate-180" />
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
          className={`sidebar ${isSidebarCollapsed ? "sidebar-collapsed" : ""}`}
          style={{ width: isSidebarCollapsed ? 76 : sidebarWidth }}
        >
          {isSidebarCollapsed ? (
            renderSidebarRail()
          ) : leftPanel === "connections" ? (
            <ConnectionList
              onNewConnection={() => onOpenConnectionForm("connect")}
            />
          ) : (
            <div className="workspace-sidebar-shell">
              <div className="workspace-sidebar-rail">
                <button
                  type="button"
                  className={`workspace-sidebar-rail-btn ${leftPanel === "database" ? "active" : ""}`}
                  onClick={onHandleShowDatabaseWorkspace}
                  title={t("sidebar.databaseExplorer")}
                >
                  <FolderTree className="w-4 h-4" />
                  <span>{t("sidebar.dbShort")}</span>
                </button>
                <button
                  type="button"
                  className={`workspace-sidebar-rail-btn ${leftPanel === "metrics" ? "active" : ""}`}
                  onClick={onOpenMetricsBoard}
                  title={t("sidebar.metricsBoards")}
                >
                  <BarChart3 className="w-4 h-4" />
                  <span>{t("sidebar.metricsShort")}</span>
                </button>
              </div>

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
            </div>
          )}
        </aside>

        {!isSidebarCollapsed && (
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
                      ? t("workspace.kicker.sql")
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
                {activeWorkspaceActivity && (
                  <span className="workspace-toolbar-mini-note">
                    {activeWorkspaceActivity.label} {activeWorkspaceActivity.durationMs}ms
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
                      <Plus className="w-3.5 h-3.5" />
                      <span>{t("toolbar.newQuery")}</span>
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
                      onClick={onFocusExplorerSearch}
                      className="toolbar-btn icon-only"
                      title={t("toolbar.findTable")}
                    >
                      <Search className="w-3.5 h-3.5" />
                    </button>

                    <button
                      onClick={onOpenMetricsBoard}
                      className="toolbar-btn icon-only"
                      title={t("toolbar.openMetricsBoard")}
                    >
                      <BarChart3 className="w-3.5 h-3.5" />
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
    </>
  );
}
