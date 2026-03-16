import { X, Table, Code, Columns, Play, Loader2, Shield } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../stores/appStore";

interface QueryChromeState {
  isRunning: boolean;
}

interface Props {
  queryChrome?: QueryChromeState | null;
  sandboxEnabled?: boolean;
  onToggleSandbox?: () => void;
  onRunActiveQuery?: () => void;
}

export function TabBar({ queryChrome, sandboxEnabled = true, onToggleSandbox, onRunActiveQuery }: Props) {
  const { tabs, activeTabId, setActiveTab, removeTab } = useAppStore(
    useShallow((state) => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      setActiveTab: state.setActiveTab,
      removeTab: state.removeTab,
    }))
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;

  const getTabIcon = (type: string) => {
    switch (type) {
      case "table":
        return <Table className="w-3.5 h-3.5" />;
      case "structure":
        return <Columns className="w-3.5 h-3.5" />;
      case "query":
      default:
        return <Code className="w-3.5 h-3.5" />;
    }
  };

  if (tabs.length === 0) return null;

  return (
    <div className="tabbar-shell">
      <div className="tabbar-summary">
        <span className="tabbar-summary-count">{tabs.length}</span>
        <span>{tabs.length === 1 ? "tab" : "tabs"}</span>
      </div>

      <div className="tabbar-list">
        {tabs.map((tab) => {
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
            onClick={onToggleSandbox}
            className={`tabbar-sandbox-btn ${sandboxEnabled ? "active" : ""}`}
            title={sandboxEnabled ? "Sandbox mode is on. Changes are rolled back." : "Sandbox mode is off. Queries run against the real database."}
          >
            <Shield className="w-3.5 h-3.5" />
            <span>{sandboxEnabled ? "Sandbox" : "Live"}</span>
          </button>
          <button
            type="button"
            onClick={onRunActiveQuery}
            className="tabbar-run-btn"
            title={sandboxEnabled ? "Execute in sandbox (Ctrl+Enter)" : "Execute query (Ctrl+Enter)"}
            disabled={queryChrome?.isRunning}
          >
            {queryChrome?.isRunning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            <span>Run</span>
          </button>
        </div>
      )}
    </div>
  );
}
