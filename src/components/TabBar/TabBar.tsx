import { X, Table, Code, Columns, Play, Square, BarChart3, Terminal } from "lucide-react";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { DatabaseType } from "../../types/database";
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

// Pure icon resolver: no longer depends on the `connections` array, only on
// the resolved db_type, so it is safe to memoize per tab.
function getTabIcon(type: string, dbType?: DatabaseType) {
  switch (type) {
    case "table":
      return <Table className="w-3.5 h-3.5" />;
    case "structure":
      return <Columns className="w-3.5 h-3.5" />;
    case "metrics":
      return <BarChart3 className="w-3.5 h-3.5" />;
    case "query":
      return getQueryProfile(dbType).surface === "command" ? (
        <Terminal className="w-3.5 h-3.5" />
      ) : (
        <Code className="w-3.5 h-3.5" />
      );
    default:
      return <Code className="w-3.5 h-3.5" />;
  }
}

interface TabBarItemProps {
  id: string;
  type: string;
  title: string;
  isPreview: boolean;
  isActive: boolean;
  isDragOver: boolean;
  dbType?: DatabaseType;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onPin: (id: string) => void;
  onDragStart: (id: string, event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (id: string, event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (id: string) => void;
  onDrop: (id: string, event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}

// Memoized tab: with all props being primitives or referentially-stable
// callbacks, a tab switch only re-renders the two tabs whose `isActive`
// flipped, instead of reconciling the whole strip (Phase 3C follow-up #2).
const TabBarItem = memo(function TabBarItem({
  id,
  type,
  title,
  isPreview,
  isActive,
  isDragOver,
  dbType,
  onSelect,
  onClose,
  onPin,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: TabBarItemProps) {
  return (
    <div
      className={[
        "tabbar-tab",
        isActive ? "active" : "",
        isPreview ? "preview" : "",
        isDragOver ? "drag-over" : "",
      ].join(" ")}
      draggable
      onDragStart={(event) => onDragStart(id, event)}
      onDragOver={(event) => onDragOver(id, event)}
      onDragLeave={() => onDragLeave(id)}
      onDrop={(event) => onDrop(id, event)}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(id)}
      onDoubleClick={() => onPin(id)}
    >
      <span className={`tabbar-tab-icon ${isActive ? "active" : ""}`}>
        {getTabIcon(type, dbType)}
      </span>
      <span className="tabbar-tab-title" style={{ fontStyle: isPreview ? "italic" : "normal" }}>
        {title}
      </span>

      <button
        className={["tabbar-close-btn", isActive ? "visible" : ""].join(" ")}
        onClick={(event) => {
          event.stopPropagation();
          onClose(id);
        }}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
});

export function TabBar({
  queryChrome,
  onRunActiveQuery,
  onCancelActiveQuery,
  onClearVisibleTabs,
}: Props) {
  const { t } = useI18n();
  const { tabs, activeTabId, setActiveTab, removeTab, pinTab, moveTab } = useUIStore(
    useShallow((state) => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      setActiveTab: state.setActiveTab,
      removeTab: state.removeTab,
      pinTab: state.pinTab,
      moveTab: state.moveTab,
    })),
  );
  const dragTabIdRef = useRef<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const connections = useConnectionStore((state) => state.connections);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;
  const visibleTabs = tabs.filter((tab) => tab.type !== "metrics");

  // Build a stable connectionId -> db_type lookup once per `connections`
  // change, so a tab switch does not run `connections.find` per tab.
  const connectionDbTypeById = useMemo(() => {
    const map = new Map<string, DatabaseType | undefined>();
    for (const connection of connections) {
      map.set(connection.id, connection.db_type);
    }
    return map;
  }, [connections]);

  // Referentially-stable handlers: store actions are already stable, and the
  // drag handlers only touch a ref + a stable setter, so these keep their
  // identity across renders and let `TabBarItem`'s memo hold.
  const handleSelect = useCallback((id: string) => setActiveTab(id), [setActiveTab]);
  const handleClose = useCallback((id: string) => removeTab(id), [removeTab]);
  const handlePin = useCallback((id: string) => pinTab(id), [pinTab]);
  const handleDragStart = useCallback((id: string, event: DragEvent<HTMLDivElement>) => {
    dragTabIdRef.current = id;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
  }, []);
  const handleDragOver = useCallback((id: string, event: DragEvent<HTMLDivElement>) => {
    if (dragTabIdRef.current == null || dragTabIdRef.current === id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverTabId(id);
  }, []);
  const handleDragLeave = useCallback((id: string) => {
    setDragOverTabId((current) => (current === id ? null : current));
  }, []);
  const handleDrop = useCallback(
    (id: string, event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const sourceId = dragTabIdRef.current;
      if (sourceId && sourceId !== id) moveTab(sourceId, id);
      dragTabIdRef.current = null;
      setDragOverTabId(null);
    },
    [moveTab],
  );
  const handleDragEnd = useCallback(() => {
    dragTabIdRef.current = null;
    setDragOverTabId(null);
  }, []);

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
        {visibleTabs.map((tab) => (
          <TabBarItem
            key={tab.id}
            id={tab.id}
            type={tab.type}
            title={tab.title}
            isPreview={Boolean(tab.isPreview)}
            isActive={activeTabId === tab.id}
            isDragOver={dragOverTabId === tab.id}
            dbType={tab.connectionId ? connectionDbTypeById.get(tab.connectionId) : undefined}
            onSelect={handleSelect}
            onClose={handleClose}
            onPin={handlePin}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
          />
        ))}
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
