import { Database, TriangleAlert, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { emitAppToast } from "../../utils/app-toast";
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
  onOpenDatabaseFile: () => void;
  windowControls?: ReactNode;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getInitialLayoutMode(): ConnectionLayoutMode {
  if (typeof window === "undefined") return "stacked";
  const stored = window.localStorage.getItem(STARTUP_CONNECTION_LAYOUT_STORAGE_KEY);
  return stored === "grid" ? "grid" : "stacked";
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export function StartupConnectionManager({ onNewConnection, onOpenDatabaseFile, windowControls }: Props) {
  const { t, language } = useI18n();
  const isDesktopWindow = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const {
    connections,
    activeConnectionId,
    connectedIds,
    isConnecting,
    loadSavedConnections,
    connectSavedConnection,
    disconnectFromDatabase,
    deleteSavedConnection,
    fetchDatabases,
    fetchTables,
  } = useAppStore(
    useShallow((state) => ({
      connections: state.connections,
      activeConnectionId: state.activeConnectionId,
      connectedIds: state.connectedIds,
      isConnecting: state.isConnecting,
      loadSavedConnections: state.loadSavedConnections,
      connectSavedConnection: state.connectSavedConnection,
      disconnectFromDatabase: state.disconnectFromDatabase,
      deleteSavedConnection: state.deleteSavedConnection,
      fetchDatabases: state.fetchDatabases,
      fetchTables: state.fetchTables,
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
  const [pendingDeleteConnection, setPendingDeleteConnection] = useState<ConnectionConfig | null>(null);
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
    void loadSavedConnections();
  }, [loadSavedConnections]);

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

  useEffect(() => {
    const focusConnectionCard = (connectionId: string, behavior: ScrollBehavior = "smooth") => {
      setSelectedConnectionId(connectionId);
      window.requestAnimationFrame(() => {
        const card = listRef.current?.querySelector<HTMLElement>(`[data-conn-id="${connectionId}"]`);
        card?.scrollIntoView({ block: "nearest", behavior });
      });
    };

    const handleLauncherFocusConnection = (event: Event) => {
      const detail = (event as CustomEvent<{ connectionId?: string; immediate?: boolean }>).detail;
      if (!detail?.connectionId) return;
      focusConnectionCard(detail.connectionId, detail.immediate ? "auto" : "smooth");
    };

    window.addEventListener("launcher-focus-connection", handleLauncherFocusConnection);

    return () => {
      window.removeEventListener("launcher-focus-connection", handleLauncherFocusConnection);
    };
  }, []);

  useEffect(() => {
    if (!pendingDeleteConnection) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPendingDeleteConnection(null);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [pendingDeleteConnection]);

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
    setSelectedConnectionId(connection.id);
    setHoverPreview(null);
    if (connectedIds.has(connection.id)) {
      const currentDatabase = useAppStore.getState().currentDatabase ?? null;
      const targetDatabase = connection.database ?? null;
      useAppStore.setState({
        activeConnectionId: connection.id,
        currentDatabase: targetDatabase,
        schemaObjects: [],
        ...(targetDatabase ? {} : { tables: [] }),
      });

      if (activeConnectionId === connection.id && currentDatabase === targetDatabase) {
        return;
      }

      void fetchDatabases(connection.id);
      if (targetDatabase) {
        void fetchTables(connection.id, targetDatabase);
      }
      return;
    }
    await connectSavedConnection(connection.id);
  };

  const handleDeleteConnection = (connection: ConnectionConfig) => {
    setPendingDeleteConnection(connection);
  };

  const confirmDeleteConnection = async () => {
    if (!pendingDeleteConnection) return;

    const connection = pendingDeleteConnection;
    const label =
      connection.name ||
      connection.database ||
      connection.host ||
      connection.file_path ||
      t("connections.untitled");

    setHoverPreview(null);
    setPendingDeleteConnection(null);

    if (connectedIds.has(connection.id)) {
      await disconnectFromDatabase(connection.id);
    }

    await deleteSavedConnection(connection.id);

    const stillExists = useAppStore.getState().connections.some((item) => item.id === connection.id);
    if (stillExists) return;

    emitAppToast({
      tone: "success",
      title: t("connections.delete"),
      description: label,
    });
  };

  const handleConnectionHover = (event: ReactMouseEvent<HTMLDivElement>, connectionId: string) => {
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

  const pendingDeleteLabel =
    pendingDeleteConnection?.name ||
    pendingDeleteConnection?.database ||
    pendingDeleteConnection?.host ||
    pendingDeleteConnection?.file_path ||
    t("connections.untitled");
  const deleteConnectionTitle =
    language === "vi"
      ? "Xóa kết nối đã lưu này?"
      : language === "zh"
        ? "删除这个已保存连接？"
        : "Delete this saved connection?";
  const deleteConnectionDescription =
    language === "vi"
      ? "Thao tác này chỉ xóa card đã lưu trong launcher, không xóa cơ sở dữ liệu thật."
      : language === "zh"
        ? "这只会移除启动器里的已保存卡片，不会删除真实数据库。"
        : "This removes only the saved launcher card. It does not delete the real database.";
  const deleteConnectionDisconnectHint =
    language === "vi"
      ? "Kết nối hiện tại sẽ được ngắt trước khi card đã lưu bị xóa."
      : language === "zh"
        ? "当前连接会先断开，然后才会移除这张已保存卡片。"
        : "The current connection will be disconnected first before the saved card is removed.";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="startup-manager-backdrop">
      <div className="startup-manager-modal">
        <div
          className="startup-manager-topbar"
          onMouseDown={(event) => {
            if (!isDesktopWindow) return;
            const target = event.target as HTMLElement | null;
            if (
              target?.closest(
                "button, input, textarea, select, option, a, [role='button'], [contenteditable='true'], [data-no-window-drag='true']",
              )
            ) {
              return;
            }
            void (async () => {
              try {
                await getCurrentWindow().startDragging();
              } catch (windowError) {
                console.error("Failed to start dragging launcher window", windowError);
              }
            })();
          }}
        >
          <div className="startup-manager-topbar-brand">
            <Database className="startup-manager-topbar-icon w-4 h-4" />
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
            isConnecting={isConnecting}
            filteredConnections={filteredConnections}
            selectedConnectionId={selectedConnectionId}
            activeConnectionId={activeConnectionId}
            connectedIds={connectedIds}
            groups={groups}
            tags={tags}
            collapsedGroupIds={collapsedGroupIds}
            onSelectConnection={setSelectedConnectionId}
            onConnect={handleOpenConnection}
            onDeleteConnection={handleDeleteConnection}
            onHover={handleConnectionHover}
            onLeaveHover={() => setHoverPreview(null)}
            onNewConnection={onNewConnection}
            onOpenDatabaseFile={onOpenDatabaseFile}
            onToggleGroup={handleToggleGroup}
            onRenameGroup={handleRenameGroup}
            onChangeGroupColor={handleChangeGroupColor}
            onDeleteGroup={handleDeleteGroup}
            listRef={listRef}
          />
        </div>

        <HoverPopover data={hoveredConnectionPanel} />

        {pendingDeleteConnection ? (
          <div
            className="startup-manager-confirm-backdrop"
            onClick={() => setPendingDeleteConnection(null)}
          >
            <div
              className="startup-manager-confirm-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="startup-delete-connection-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="startup-manager-confirm-head">
                <div className="startup-manager-confirm-title-wrap">
                  <div className="startup-manager-confirm-icon">
                    <TriangleAlert className="w-4 h-4" />
                  </div>
                  <div className="startup-manager-confirm-copy">
                    <span className="startup-manager-kicker">
                      {t("connections.delete")}
                    </span>
                    <strong id="startup-delete-connection-title">
                      {deleteConnectionTitle}
                    </strong>
                  </div>
                </div>

                <button
                  type="button"
                  className="startup-manager-confirm-close"
                  onClick={() => setPendingDeleteConnection(null)}
                  aria-label={t("common.cancel")}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="startup-manager-confirm-body">
                <div className="startup-manager-confirm-target">
                  <span className="startup-manager-confirm-label">{t("common.connections")}</span>
                  <strong className="startup-manager-confirm-value">{pendingDeleteLabel}</strong>
                </div>

                <p className="startup-manager-confirm-description">
                  {deleteConnectionDescription}
                </p>

                {connectedIds.has(pendingDeleteConnection.id) ? (
                  <p className="startup-manager-confirm-note">
                    {deleteConnectionDisconnectHint}
                  </p>
                ) : null}
              </div>

              <div className="startup-manager-confirm-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setPendingDeleteConnection(null)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary danger"
                  onClick={() => {
                    void confirmDeleteConnection();
                  }}
                >
                  {t("common.delete")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
