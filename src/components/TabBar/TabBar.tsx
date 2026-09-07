import { X, Table, Code, Columns, Play, Square, BarChart3, Terminal } from "lucide-react";
import { useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConnectionStore } from "../../stores/connectionStore";
import { useUIStore } from "../../stores/uiStore";
import { useI18n } from "../../i18n";
import { getQueryProfile } from "../../utils/query-profile";

interface QueryChromeState {
  isRunning: boolean;
}

interface Props {
  queryChrome?: QueryChromeState | null;
  onRunActiveQuery?: () => void;
  onCancelActiveQuery?: () => void;
  onClearVisibleTabs?: () => void;
}

export function TabBar({ queryChrome, onRunActiveQuery, onCancelActiveQuery, onClearVisibleTabs }: Props) {
  const { t } = useI18n();
  const { tabs, activeTabId, setActiveTab, removeTab, pinTab, moveTab } = useUIStore(
    useShallow((state) => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      setActiveTab: state.setActiveTab,
      removeTab: state.removeTab,
      pinTab: state.pinTab,
      moveTab: state.moveTab,
    }))
  );
  const dragTabIdRef = useRef<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const connections = useConnectionStore((state) => state.connections);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;
  const visibleTabs = tabs.filter((tab) => tab.type !== "metrics");

  const getTabIcon = (type: string, connectionId?: string) => {
    switch (type) {
      case "table":
        return <Table className="w-3.5 h-3.5" />;
      case "structure":
        return <Columns className="w-3.5 h-3.5" />;
      case "metrics":
        return <BarChart3 className="w-3.5 h-3.5" />;
      case "query": {
        const dbType = connections.find((connection) => connection.id === connectionId)?.db_type;
        return getQueryProfile(dbType).surface === "command"
          ? <Terminal className="w-3.5 h-3.5" />
          : <Code className="w-3.5 h-3.5" />;
      }
      default:
        return <Code className="w-3.5 h-3.5" />;
    }
  };

  if (visibleTabs.length === 0) return null;
  if (activeTab?.type === "metrics") return null;
  if (activeTab?.type === "er-diagram") return null;

  const showClearButton = visibleTabs.length > 1;
  const showRunButton = activeTab?.type === "query";
  const hasTrailingActions = showClearButton || showRunButton;

  return (
    <div className={`tabbar-shell ${hasTrailingActions ? "has-trailing" : ""}`}>
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
                isActive ? "active" : "",
                tab.isPreview ? "preview" : "",
                dragOverTabId === tab.id ? "drag-over" : "",
              ].join(" ")}
              draggable
              onDragStart={(event) => {
                dragTabIdRef.current = tab.id;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", tab.id);
              }}
              onDragOver={(event) => {
                if (dragTabIdRef.current == null || dragTabIdRef.current === tab.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDragOverTabId(tab.id);
              }}
              onDragLeave={() => {
                setDragOverTabId((current) => (current === tab.id ? null : current));
              }}
              onDrop={(event) => {
                event.preventDefault();
                const sourceId = dragTabIdRef.current;
                if (sourceId && sourceId !== tab.id) moveTab(sourceId, tab.id);
                dragTabIdRef.current = null;
                setDragOverTabId(null);
              }}
              onDragEnd={() => {
                dragTabIdRef.current = null;
                setDragOverTabId(null);
              }}
              onClick={() => setActiveTab(tab.id)}
              onDoubleClick={() => pinTab(tab.id)}
            >
              <span className={`tabbar-tab-icon ${isActive ? "active" : ""}`}>
                {getTabIcon(tab.type, tab.connectionId)}
              </span>
              <span className="tabbar-tab-title" style={{ fontStyle: tab.isPreview ? "italic" : "normal" }}>{tab.title}</span>

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

      {hasTrailingActions && (
        <div className="tabbar-trailing">
          {showClearButton && (
            <button
              type="button"
              onClick={onClearVisibleTabs}
              className="tabbar-clear-btn"
              title={t("toolbar.closeAllTabs")}
            >
              <X className="w-3.5 h-3.5" />
              <span>{t("toolbar.clear")}</span>
            </button>
          )}

          {showRunButton && (
            <button
              data-testid="run-query"
              type="button"
              onClick={queryChrome?.isRunning ? onCancelActiveQuery : onRunActiveQuery}
              className="tabbar-run-btn"
              title={queryChrome?.isRunning ? "Stop query" : t("tabs.runTitle")}
            >
              {queryChrome?.isRunning ? (
                <Square className="w-3.5 h-3.5" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              <span>{queryChrome?.isRunning ? "Stop" : t("tabs.run")}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
