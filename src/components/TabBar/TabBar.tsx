import { Plus, X, Table, Code, Columns } from "lucide-react";
import { useAppStore } from "../../stores/appStore";

interface Props {
  onNewQuery?: () => void;
}

export function TabBar({ onNewQuery }: Props) {
  const { tabs, activeTabId, setActiveTab, removeTab, addTab, activeConnectionId } = useAppStore();

  const handleNewQuery = () => {
    if (onNewQuery) {
      onNewQuery();
      return;
    }

    if (!activeConnectionId) return;
    const id = `query-${Date.now()}`;
    addTab({
      id,
      type: "query",
      title: "New Query",
      connectionId: activeConnectionId,
    });
  };

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

  if (tabs.length === 0 && !activeConnectionId) return null;

  return (
    <div className="tabbar-shell" style={{ scrollbarWidth: "thin" }}>
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

      {activeConnectionId && (
        <button
          onClick={handleNewQuery}
          className="tabbar-new-btn"
          title="New Query (Ctrl+N)"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Query</span>
        </button>
      )}
    </div>
  );
}
