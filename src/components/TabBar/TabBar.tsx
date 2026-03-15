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
    <div
      className="flex h-11 items-stretch bg-[rgba(255,255,255,0.02)] border-b border-[var(--border-color)] overflow-x-auto flex-shrink-0"
      style={{ scrollbarWidth: "thin" }}
    >
      <div className="tabbar-summary">
        <span className="tabbar-summary-count">{tabs.length}</span>
        <span>{tabs.length === 1 ? "tab" : "tabs"}</span>
      </div>

      <div className="flex h-full items-stretch flex-1 min-w-0">
        {tabs.map((tab) => {
          const isActive = activeTabId === tab.id;
          return (
            <div
              key={tab.id}
              className={[
                "group relative flex h-full items-center gap-2.5 px-4 cursor-pointer",
                "text-[12px] min-w-0 max-w-[240px] shrink-0 select-none transition-all duration-150",
                "border-r border-[var(--border-color)] leading-none",
                isActive
                  ? "bg-[var(--accent-dim)] text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)]/85 hover:text-[var(--text-primary)] hover:bg-[rgba(255,255,255,0.06)]",
              ].join(" ")}
              onClick={() => setActiveTab(tab.id)}
            >
              {isActive && (
                <div className="absolute top-0 left-0 right-0 h-[2px] bg-[var(--accent)]" />
              )}

              <span className={`${isActive ? "text-[var(--accent-hover)]" : ""}`}>
                {getTabIcon(tab.type)}
              </span>
              <span className="truncate font-semibold">{tab.title}</span>

              <button
                className={[
                  "ml-auto p-1 rounded-sm shrink-0 transition-all",
                  isActive
                    ? "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)]"
                    : "opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)]",
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
          className="mx-3 my-1.5 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)]
            hover:bg-[rgba(122,162,255,0.18)] transition-colors text-[12px] shrink-0 leading-none border border-transparent hover:border-[rgba(122,162,255,0.26)]"
          title="New Query (Ctrl+N)"
        >
          <Plus className="w-3.5 h-3.5" />
          Query
        </button>
      )}
    </div>
  );
}
