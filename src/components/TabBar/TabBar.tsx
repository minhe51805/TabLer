import { X, Table, Code, Columns, Play, Square, BarChart3, Terminal } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent } from "react";
import type { DatabaseType, Tab } from "../../types/database";
import { useShallow } from "zustand/react/shallow";
import { useConnectionStore } from "../../stores/connectionStore";
import { useUIStore } from "../../stores/uiStore";
import type { TabPane } from "../../stores/uiStore";
import { useI18n } from "../../i18n";
import { getQueryProfile } from "../../utils/query-profile";
import { getTabBarCopy } from "./tabbar-copy";

interface QueryChromeState {
  isRunning: boolean;
}

interface Props {
  /** Which split pane this strip renders. Defaults to the primary pane. */
  pane?: TabPane;
  queryChrome?: QueryChromeState | null;
  onRunActiveQuery?: () => void;
  onCancelActiveQuery?: () => void;
  onClearVisibleTabs?: () => void;
}

interface TabContextMenuState {
  tabId: string;
  x: number;
  y: number;
}

// Module-level drag payload: both pane strips share it, so a tab dragged from
// one pane can be dropped onto the other (each instance's own ref would be
// invisible to its sibling).
let draggedTabId: string | null = null;

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
  onContextMenu: (id: string, event: MouseEvent<HTMLDivElement>) => void;
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
  onContextMenu,
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
      onContextMenu={(event) => onContextMenu(id, event)}
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
  pane = "primary",
  queryChrome,
  onRunActiveQuery,
  onCancelActiveQuery,
  onClearVisibleTabs,
}: Props) {
  const { t, language } = useI18n();
  const copy = getTabBarCopy(language);
  const {
    tabs,
    activeTabId,
    primaryActiveTabId,
    secondaryActiveTabId,
    setActiveTab,
    removeTab,
    pinTab,
    moveTab,
    moveTabToPane,
    duplicateTab,
  } = useUIStore(
    useShallow((state) => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      primaryActiveTabId: state.primaryActiveTabId,
      secondaryActiveTabId: state.secondaryActiveTabId,
      setActiveTab: state.setActiveTab,
      removeTab: state.removeTab,
      pinTab: state.pinTab,
      moveTab: state.moveTab,
      moveTabToPane: state.moveTabToPane,
      duplicateTab: state.duplicateTab,
    })),
  );
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const connections = useConnectionStore((state) => state.connections);

  const tabPane = useCallback((tab: Tab | undefined): TabPane => tab?.pane ?? "primary", []);
  const stripTabs = useMemo(
    () => tabs.filter((tab) => tab.type !== "metrics" && tabPane(tab) === pane),
    [tabs, pane, tabPane],
  );
  const splitOpen = useMemo(
    () => tabs.some((tab) => tab.type !== "metrics" && tabPane(tab) === "secondary"),
    [tabs, tabPane],
  );
  // Per-pane selection, with a fallback for states written before the pane
  // fields existed (tests, restored sessions): the global active tab counts
  // for whichever pane it lives in.
  const storedPaneActiveId = pane === "secondary" ? secondaryActiveTabId : primaryActiveTabId;
  const paneActiveTabId =
    storedPaneActiveId && stripTabs.some((tab) => tab.id === storedPaneActiveId)
      ? storedPaneActiveId
      : stripTabs.some((tab) => tab.id === activeTabId)
        ? activeTabId
        : null;
  const paneActiveTab = stripTabs.find((tab) => tab.id === paneActiveTabId) || null;
  const globalActiveTab = tabs.find((tab) => tab.id === activeTabId) || null;
  // The strip hides when its pane's content is a chrome-less workspace
  // (metrics board / ER diagram). Metrics tabs have no pane and always count
  // as primary-pane content, so the global active tab wins there.
  const stripContentTab =
    pane === "primary" && globalActiveTab && tabPane(globalActiveTab) === "primary"
      ? globalActiveTab
      : paneActiveTab;

  // Build a stable connectionId -> db_type lookup once per `connections`
  // change, so a tab switch does not run `connections.find` per tab.
  const connectionDbTypeById = useMemo(() => {
    const map = new Map<string, DatabaseType | undefined>();
    for (const connection of connections) {
      map.set(connection.id, connection.db_type);
    }
    return map;
  }, [connections]);

  // Dismiss the context menu on outside interaction.
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (event: Event) => {
      if (event.type === "mousedown" && contextMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setContextMenu(null);
    };
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [contextMenu]);

  // Referentially-stable handlers: store actions are already stable, and the
  // drag handlers only touch a module ref + a stable setter, so these keep
  // their identity across renders and let `TabBarItem`'s memo hold.
  const handleSelect = useCallback((id: string) => setActiveTab(id), [setActiveTab]);
  const handleClose = useCallback((id: string) => removeTab(id), [removeTab]);
  const handlePin = useCallback((id: string) => pinTab(id), [pinTab]);
  const handleContextMenu = useCallback((id: string, event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setContextMenu({ tabId: id, x: event.clientX, y: event.clientY });
  }, []);
  const handleDragStart = useCallback((id: string, event: DragEvent<HTMLDivElement>) => {
    draggedTabId = id;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
  }, []);
  const handleDragOver = useCallback((id: string, event: DragEvent<HTMLDivElement>) => {
    if (draggedTabId == null || draggedTabId === id) return;
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
      event.stopPropagation();
      const sourceId = draggedTabId ?? event.dataTransfer.getData("text/plain");
      if (sourceId && sourceId !== id) moveTab(sourceId, id);
      draggedTabId = null;
      setDragOverTabId(null);
    },
    [moveTab],
  );
  const handleDragEnd = useCallback(() => {
    draggedTabId = null;
    setDragOverTabId(null);
  }, []);

  // Dropping on the strip's empty tail appends the tab to this pane.
  const handleListDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (draggedTabId == null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);
  const handleListDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const sourceId = draggedTabId ?? event.dataTransfer.getData("text/plain");
      if (sourceId) moveTabToPane(sourceId, pane);
      draggedTabId = null;
      setDragOverTabId(null);
    },
    [moveTabToPane, pane],
  );

  const contextMenuTab = contextMenu ? tabs.find((tab) => tab.id === contextMenu.tabId) : undefined;

  if (stripTabs.length === 0 && !(pane === "primary" && splitOpen)) return null;
  if (stripContentTab?.type === "metrics") return null;
  if (stripContentTab?.type === "er-diagram") return null;

  const showClearButton = stripTabs.length > 1;
  // The run button drives the globally focused query tab, so it only renders
  // in the pane that currently owns the focus.
  const showRunButton = paneActiveTab?.type === "query" && paneActiveTab.id === activeTabId;
  const hasTrailingActions = showClearButton || showRunButton;

  return (
    <div className={`tabbar-shell ${hasTrailingActions ? "has-trailing" : ""}`}>
      <div className="tabbar-summary">
        <span className="tabbar-summary-count">{stripTabs.length}</span>
        <span>{stripTabs.length === 1 ? t("tabs.tab") : t("tabs.tabs")}</span>
      </div>

      <div className="tabbar-list" onDragOver={handleListDragOver} onDrop={handleListDrop}>
        {stripTabs.map((tab) => (
          <TabBarItem
            key={tab.id}
            id={tab.id}
            type={tab.type}
            title={tab.title}
            isPreview={Boolean(tab.isPreview)}
            isActive={paneActiveTabId === tab.id}
            isDragOver={dragOverTabId === tab.id}
            dbType={tab.connectionId ? connectionDbTypeById.get(tab.connectionId) : undefined}
            onSelect={handleSelect}
            onClose={handleClose}
            onPin={handlePin}
            onContextMenu={handleContextMenu}
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

      {contextMenu && contextMenuTab && (
        <div
          ref={contextMenuRef}
          className="structure-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className="structure-context-menu-item"
            onClick={() => {
              duplicateTab(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            {copy.duplicate}
          </button>
          {tabPane(contextMenuTab) === "primary" ? (
            <button
              type="button"
              role="menuitem"
              className="structure-context-menu-item"
              onClick={() => {
                moveTabToPane(contextMenu.tabId, "secondary");
                setContextMenu(null);
              }}
            >
              {copy.splitRight}
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="structure-context-menu-item"
              onClick={() => {
                moveTabToPane(contextMenu.tabId, "primary");
                setContextMenu(null);
              }}
            >
              {copy.moveToLeftPane}
            </button>
          )}
          {splitOpen && (
            <button
              type="button"
              role="menuitem"
              className="structure-context-menu-item"
              onClick={() => {
                useUIStore.getState().removeTabsForPane("secondary");
                setContextMenu(null);
              }}
            >
              {copy.closeSplit}
            </button>
          )}
          <div className="structure-context-menu-separator" />
          <button
            type="button"
            role="menuitem"
            className="structure-context-menu-item danger"
            onClick={() => {
              removeTab(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            {copy.closeTab}
          </button>
        </div>
      )}
    </div>
  );
}
