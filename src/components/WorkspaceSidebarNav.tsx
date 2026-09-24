import { Activity, BarChart3, FolderTree, GitBranch, PanelRightClose, Plus } from "lucide-react";
import type { useI18n } from "../i18n";

type TFunction = ReturnType<typeof useI18n>["t"];

/** Left rail nav: database explorer, ER diagram, metrics, profiler launcher,
 *  plus new-connection and the collapse toggle. `compact` (collapsed sidebar)
 *  hides labels but keeps the same item set so the two states never drift. */
export function WorkspaceSidebarNav({
  compact,
  t,
  isConnected,
  isDatabasePanelActive,
  isERDiagramPanelActive,
  isMetricsPanelActive,
  activeConnId,
  onHandleShowDatabaseWorkspace,
  onOpenERDiagram,
  onOpenMetricsBoard,
  onSetConnectionFormIntent,
  onToggleSidebar,
}: {
  compact: boolean;
  t: TFunction;
  isConnected: boolean;
  isDatabasePanelActive: boolean;
  isERDiagramPanelActive: boolean;
  isMetricsPanelActive: boolean;
  activeConnId?: string;
  onHandleShowDatabaseWorkspace: () => void;
  onOpenERDiagram: () => void;
  onOpenMetricsBoard: () => void;
  onSetConnectionFormIntent: (intent: "connect") => void;
  onToggleSidebar: () => void;
}) {
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
      onClick: onOpenERDiagram,
      disabled: !isConnected || !activeConnId,
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
    {
      key: "profiler",
      icon: Activity,
      label: t("sidebar.profilerShort"),
      title: t("sidebar.liveProfiler"),
      // The profiler is a modal overlay, not a workspace panel, so it has no
      // persistent "active" panel state — the rail button just launches it.
      active: false,
      onClick: () => window.dispatchEvent(new CustomEvent("open-live-profiler")),
      disabled: !isConnected,
    },
  ] as const;

  return (
    <div
      className={
        compact
          ? "workspace-sidebar-rail workspace-sidebar-rail--compact"
          : "workspace-sidebar-rail"
      }
    >
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
}
