import { X, Table, Code, Columns, Play, Loader2, BarChart3 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n";

interface QueryChromeState {
  isRunning: boolean;
}

interface Props {
  queryChrome?: QueryChromeState | null;
  onRunActiveQuery?: () => void;
}

export function TabBar({ queryChrome, onRunActiveQuery }: Props) {
  const { t } = useI18n();
  const { tabs, activeTabId, setActiveTab, removeTab } = useAppStore(
    useShallow((state) => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      setActiveTab: state.setActiveTab,
      removeTab: state.removeTab,
    }))
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;
  const visibleTabs = tabs.filter((tab) => tab.type !== "metrics");

  const getTabIcon = (type: string) => {
    switch (type) {
      case "table":
        return <Table className="w-3.5 h-3.5" />;
      case "structure":
        return <Columns className="w-3.5 h-3.5" />;
      case "metrics":
        return <BarChart3 className="w-3.5 h-3.5" />;
      case "query":
      default:
        return <Code className="w-3.5 h-3.5" />;
    }
  };

  if (visibleTabs.length === 0) return null;
  if (activeTab?.type === "metrics") return null;

  return (
    <div className="tabbar-shell">
      <div className="tabbar-summary">
        <span className="tabbar-summary-count">{visibleTabs.length}</span>
        <span>{visibleTabs.length === 1 ? t("tabs.tab") : t("tabs.tabs")}</span>
      </div>

      <div className="tabbar-list">
        {visibleTabs.map((tab) => {
          const isActive = activeTabId === tab.id;
          return (
            <div
              key={tab.id}
              className={[
                "tabbar-tab",
                isActive
                  ? "active"
                  : "",
              ].join(" ")}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className={`tabbar-tab-icon ${isActive ? "active" : ""}`}>
                {getTabIcon(tab.type)}
              </span>
              <span className="tabbar-tab-title">{tab.title}</span>

              <button
                className={[
                  "tabbar-close-btn",
                  isActive ? "visible" : "",
                ].join(" ")}
                onClick={(e) => {
                  e.stopPropagation();
                  removeTab(tab.id);
                }}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>

      {activeTab?.type === "query" && (
        <div className="tabbar-trailing">
          <button
            type="button"
            onClick={onRunActiveQuery}
            className="tabbar-run-btn"
            title={t("tabs.runTitle")}
            disabled={queryChrome?.isRunning}
          >
            {queryChrome?.isRunning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            <span>{t("tabs.run")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
