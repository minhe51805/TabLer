import { Database } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useI18n } from "../../i18n";
import { useAppStore } from "../../stores/appStore";
import {
  changeGroupColor,
  deleteGroup,
  getCollapsedGroupIds,
  getGroups,
  renameGroup,
  toggleGroupCollapse,
  type ConnectionGroup,
} from "../../stores/connection-group-store";
import { getTags, type ConnectionTag } from "../../stores/connection-tag-store";
import type { ConnectionConfig } from "./types";
import type { ConnectionLayoutMode, HoverPreviewState } from "./types";
import {
  STARTUP_CONNECTION_LAYOUT_STORAGE_KEY,
  buildDatabaseLabel,
  buildEndpointLabel,
} from "./types";
import { ConnectionListView } from "./ConnectionListView";
import { HoverPopover } from "./HoverPopover";
import { StartupBrandingPanel } from "./StartupBrandingPanel";

interface Props {
  onNewConnection: () => void;
  windowControls?: ReactNode;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getInitialLayoutMode(): ConnectionLayoutMode {
  if (typeof window === "undefined") return "stacked";
  const stored = window.localStorage.getItem(STARTUP_CONNECTION_LAYOUT_STORAGE_KEY);
  return stored === "grid" ? "grid" : "stacked";
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export function StartupConnectionManager({ onNewConnection, windowControls }: Props) {
  const { t } = useI18n();
  const {
    connections,
    activeConnectionId,
    connectedIds,
    isConnecting,
    connectSavedConnection,
    fetchDatabases,
    fetchTables,
    fetchSchemaObjects,
  } = useAppStore(
    useShallow((state) => ({
      connections: state.connections,
      activeConnectionId: state.activeConnectionId,
      connectedIds: state.connectedIds,
      isConnecting: state.isConnecting,
      connectSavedConnection: state.connectSavedConnection,
      fetchDatabases: state.fetchDatabases,
      fetchTables: state.fetchTables,
      fetchSchemaObjects: state.fetchSchemaObjects,
    })),
  );

  // ── Group & Tag State ───────────────────────────────────────────────────────

  const [groups, setGroups] = useState<ConnectionGroup[]>(() => getGroups());
  const [tags] = useState<ConnectionTag[]>(() => getTags());
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(() => getCollapsedGroupIds());

  const refreshGroups = () => setGroups(getGroups());

  // ── Core State ─────────────────────────────────────────────────────────────

  const [search, setSearch] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [layoutMode, setLayoutMode] = useState<ConnectionLayoutMode>(getInitialLayoutMode);
  const [hoverPreview, setHoverPreview] = useState<HoverPreviewState | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // ── Derived Data ───────────────────────────────────────────────────────────

  const sortedConnections = useMemo(() => {
    const getRank = (conn: ConnectionConfig) => {
      if (activeConnectionId === conn.id) return 0;
      if (connectedIds.has(conn.id)) return 1;
      return 2;
    };
    const getLabel = (conn: ConnectionConfig) =>
      (conn.name || conn.database || conn.host || conn.file_path || "").toLocaleLowerCase();
    return [...connections].sort((a, b) => {
      const diff = getRank(a) - getRank(b);
      return diff !== 0 ? diff : getLabel(a).localeCompare(getLabel(b));
    });
  }, [activeConnectionId, connectedIds, connections]);

  const filteredConnections = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return sortedConnections;
    return sortedConnections.filter((conn) => {
      const haystack = [conn.name, conn.host, conn.database, conn.username, conn.file_path, conn.db_type]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return haystack.includes(needle);
    });
  }, [search, sortedConnections]);

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!selectedConnectionId || !filteredConnections.some((c) => c.id === selectedConnectionId)) {
      setSelectedConnectionId(filteredConnections[0]?.id ?? null);
    }
  }, [filteredConnections, selectedConnectionId]);

  useEffect(() => {
    window.localStorage.setItem(STARTUP_CONNECTION_LAYOUT_STORAGE_KEY, layoutMode);
  }, [layoutMode]);

  useEffect(() => {
    if (layoutMode !== "grid") setHoverPreview(null);
  }, [layoutMode]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const clear = () => setHoverPreview(null);
    el.addEventListener("scroll", clear);
    window.addEventListener("resize", clear);
    return () => {
      el.removeEventListener("scroll", clear);
      window.removeEventListener("resize", clear);
    };
  }, []);

  // ── Group Handlers ─────────────────────────────────────────────────────────

  const handleToggleGroup = (groupId: string) => {
    toggleGroupCollapse(groupId);
    setCollapsedGroupIds(getCollapsedGroupIds());
  };

  const handleRenameGroup = (groupId: string, name: string) => {
    renameGroup(groupId, name);
    refreshGroups();
  };

  const handleChangeGroupColor = (groupId: string, color: string) => {
    changeGroupColor(groupId, color);
    refreshGroups();
  };

  const handleDeleteGroup = (groupId: string) => {
    deleteGroup(groupId);
    refreshGroups();
    setCollapsedGroupIds(getCollapsedGroupIds());
  };


  // ── Connection Handlers ─────────────────────────────────────────────────────

  const handleOpenConnection = async (connection: ConnectionConfig) => {
    if (isConnecting) return;
    if (connectedIds.has(connection.id)) {
      useAppStore.setState({
        activeConnectionId: connection.id,
        currentDatabase: connection.database ?? null,
        ...(connection.database ? {} : { tables: [], schemaObjects: [] }),
      });
      await fetchDatabases(connection.id);
      if (connection.database) {
        useAppStore.setState({ currentDatabase: connection.database });
        await Promise.all([
          fetchTables(connection.id, connection.database),
          fetchSchemaObjects(connection.id, connection.database),
        ]);
      }
      return;
    }
    await connectSavedConnection(connection.id);
  };

  const handleConnectionHover = (event: ReactMouseEvent<HTMLButtonElement>, connectionId: string) => {
    if (layoutMode !== "grid") return;
    const rect = event.currentTarget.getBoundingClientRect();
    setHoverPreview({ connectionId, top: rect.top, left: rect.left, right: rect.right });
  };

  // ── Hover Popover ───────────────────────────────────────────────────────────

  const hoveredConnectionPanel = useMemo(() => {
    if (!hoverPreview || layoutMode !== "grid") return null;
    const conn =
      filteredConnections.find((c) => c.id === hoverPreview.connectionId) ??
      connections.find((c) => c.id === hoverPreview.connectionId);
    if (!conn) return null;

    const popupWidth = 244;
    const popupHeight = 196;
    const viewportPadding = 16;
    const gap = 12;
    const vw = typeof window === "undefined" ? 0 : window.innerWidth;
    const vh = typeof window === "undefined" ? 0 : window.innerHeight;

    let left = hoverPreview.right + gap;
    if (left + popupWidth > vw - viewportPadding) {
      left = Math.max(viewportPadding, hoverPreview.left - popupWidth - gap);
    }
    const top = Math.max(
      viewportPadding,
      Math.min(hoverPreview.top - 4, vh - popupHeight - viewportPadding),
    );

    const isConnected = connectedIds.has(conn.id);
    const isActive = activeConnectionId === conn.id;

    return {
      connection: conn,
      statusLabel: isActive ? t("common.active") : isConnected ? t("common.connected") : t("common.saved"),
      endpointLabel: buildEndpointLabel(conn.db_type, conn.host, conn.port, conn.file_path),
      databaseLabel: buildDatabaseLabel(conn.db_type, conn.database, conn.username),
      style: { top, left },
      isActive,
      isConnected,
    };
  }, [activeConnectionId, connectedIds, connections, filteredConnections, hoverPreview, layoutMode, t]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="startup-manager-backdrop">
      <div className="startup-manager-modal">
        <div className="startup-manager-topbar">
          <div className="startup-manager-topbar-brand">
            <Database className="w-4 h-4 text-[var(--accent)]" />
            <span>TabLer</span>
          </div>
          {windowControls ? <div className="startup-manager-controls">{windowControls}</div> : null}
        </div>

        <div className="startup-manager-body">
          <StartupBrandingPanel />

          <ConnectionListView
            search={search}
            onSearchChange={setSearch}
            layoutMode={layoutMode}
            onLayoutModeChange={setLayoutMode}
            filteredConnections={filteredConnections}
            selectedConnectionId={selectedConnectionId}
            activeConnectionId={activeConnectionId}
            connectedIds={connectedIds}
            groups={groups}
            tags={tags}
            collapsedGroupIds={collapsedGroupIds}
            onSelectConnection={setSelectedConnectionId}
            onConnect={handleOpenConnection}
            onHover={handleConnectionHover}
            onLeaveHover={() => setHoverPreview(null)}
            onNewConnection={onNewConnection}
            onToggleGroup={handleToggleGroup}
            onRenameGroup={handleRenameGroup}
            onChangeGroupColor={handleChangeGroupColor}
            onDeleteGroup={handleDeleteGroup}
            listRef={listRef}
          />
        </div>

        <HoverPopover data={hoveredConnectionPanel} />
      </div>
    </div>
  );
}
