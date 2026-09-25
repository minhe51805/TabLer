import {
  Activity,
  Check,
  Database,
  FileUp,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  LayoutList,
  Loader2,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import type {
  ConnectionConfig,
  ConnectionGroup,
  ConnectionLayoutMode,
  ConnectionPingResult,
  ConnectionTag,
} from "./types";
import type { StartupCopy } from "./startup-copy";
import {
  buildDatabaseLabel,
  buildEndpointLabel,
  buildSecondaryBadgeLabel,
  detectEnvironment,
  getEnvironmentBadge,
  getDbInfo,
} from "./types";
import { useKeyboardNavigation } from "./use-keyboard-navigation";
import { ConnectionGroupHeader } from "./ConnectionGroupHeader";
import { ConnectionRow } from "./ConnectionRow";

interface Props {
  search: string;
  onSearchChange: (v: string) => void;
  layoutMode: ConnectionLayoutMode;
  onLayoutModeChange: (v: ConnectionLayoutMode) => void;
  isConnecting: boolean;
  filteredConnections: ConnectionConfig[];
  selectedConnectionId: string | null;
  activeConnectionId: string | null;
  connectedIds: Set<string>;
  groups: ConnectionGroup[];
  tags: ConnectionTag[];
  collapsedGroupIds: Set<string>;
  onSelectConnection: (id: string) => void;
  onConnect: (connection: ConnectionConfig) => void;
  onDeleteConnection: (connection: ConnectionConfig) => void;
  onRenameConnection: (connection: ConnectionConfig, name: string) => void;
  onHover: (e: React.MouseEvent<HTMLDivElement>, id: string) => void;
  onLeaveHover: () => void;
  onNewConnection: () => void;
  onOpenDatabaseFile: () => void;
  /** Show the first-run empty-state CTAs (create / sample / import) — only when
   *  the saved list is truly empty, not merely filtered to zero. */
  showEmptyStateCtas: boolean;
  sampleCopy: StartupCopy["sampleCard"];
  isCreatingSample: boolean;
  onCreateSample: () => void;
  /** Opens the connection importer (DBeaver / DataGrip / TableR exports). */
  onImportConnections: () => void;
  importCtaCopy: StartupCopy["importCta"];
  onToggleGroup: (groupId: string) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onChangeGroupColor: (groupId: string, color: string) => void;
  onDeleteGroup: (groupId: string) => void;
  /** Assign a connection to a group (null clears the assignment). */
  onAssignToGroup: (connectionId: string, groupId: string | null) => void;
  /** Create a group from the context menu and assign the connection to it. */
  onCreateAndAssignGroup: (connectionId: string, name: string) => void;
  /** Localized copy for the card context menu. */
  groupsCopy: StartupCopy["groups"];
  /** Per-connection results of the last "ping all" run. */
  pingResults: Map<string, ConnectionPingResult>;
  isPingingAll: boolean;
  onPingAll: () => void;
  pingAllCopy: StartupCopy["pingAll"];
  listRef: React.RefObject<HTMLDivElement | null>;
}

export function ConnectionListView({
  search,
  onSearchChange,
  layoutMode,
  onLayoutModeChange,
  isConnecting,
  filteredConnections,
  selectedConnectionId,
  activeConnectionId,
  connectedIds,
  groups,
  tags,
  collapsedGroupIds,
  onSelectConnection,
  onConnect,
  onDeleteConnection,
  onRenameConnection,
  onHover,
  onLeaveHover,
  onNewConnection,
  onOpenDatabaseFile,
  showEmptyStateCtas,
  sampleCopy,
  isCreatingSample,
  onCreateSample,
  onImportConnections,
  importCtaCopy,
  onToggleGroup,
  onRenameGroup,
  onChangeGroupColor,
  onDeleteGroup,
  listRef,
  pingResults,
  isPingingAll,
  onPingAll,
  pingAllCopy,
  onAssignToGroup,
  onCreateAndAssignGroup,
  groupsCopy,
}: Props) {
  const { t } = useI18n();

  // ── Card context menu (Move to group / Rename / Delete) ────────────────────

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    connectionId: string;
  } | null>(null);
  const [isNamingGroup, setIsNamingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  // Bumped to trigger rename mode on a specific card (see ConnectionRow).
  const [renameRequest, setRenameRequest] = useState<{ id: string; nonce: number } | null>(null);

  const closeContextMenu = () => {
    setContextMenu(null);
    setIsNamingGroup(false);
    setNewGroupName("");
  };

  useEffect(() => {
    if (!contextMenu) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };
    const handleScroll = () => closeContextMenu();
    window.addEventListener("click", closeContextMenu);
    window.addEventListener("contextmenu", closeContextMenu);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleScroll);
    const listEl = listRef.current;
    listEl?.addEventListener("scroll", handleScroll);
    return () => {
      window.removeEventListener("click", closeContextMenu);
      window.removeEventListener("contextmenu", closeContextMenu);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleScroll);
      listEl?.removeEventListener("scroll", handleScroll);
    };
  }, [contextMenu, listRef]);

  const openContextMenu = (event: React.MouseEvent<HTMLDivElement>, connectionId: string) => {
    event.preventDefault();
    event.stopPropagation();
    onSelectConnection(connectionId);
    setIsNamingGroup(false);
    setNewGroupName("");
    setContextMenu({ x: event.clientX, y: event.clientY, connectionId });
  };

  const contextMenuConnection = contextMenu
    ? filteredConnections.find((c) => c.id === contextMenu.connectionId)
    : undefined;

  const submitNewGroup = () => {
    const name = newGroupName.trim();
    if (!name || !contextMenu) return;
    onCreateAndAssignGroup(contextMenu.connectionId, name);
    closeContextMenu();
  };

  // ── Flat list ────────────────────────────────────────────────────────────────

  const flatItems = buildFlatList({
    connections: filteredConnections,
    groups,
    collapsedGroupIds,
    activeConnectionId,
    connectedIds,
  });

  // ── Keyboard navigation ─────────────────────────────────────────────────────

  useKeyboardNavigation({
    flatItems,
    selectedConnectionId,
    onSelectConnection,
    onConnect,
    onNewConnection,
    onToggleGroup,
    onSearchChange,
  });

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <section className="startup-manager-browser">
      <div className="startup-manager-browser-head">
        <div className="startup-manager-browser-copy">
          <h3>{t("startup.manager.pickWorkspace")}</h3>
          <span className="startup-manager-browser-meta">
            {filteredConnections.length} {t("common.connections").toLocaleLowerCase()}
          </span>
        </div>

        <div
          className="startup-manager-action-group"
          role="group"
          aria-label={t("common.connections")}
        >
          <button
            type="button"
            className="startup-manager-search-add primary"
            onClick={onNewConnection}
            aria-label={t("startup.manager.createConnection")}
            title={t("startup.manager.createConnection")}
          >
            <Plus className="w-4 h-4" />
            <span>{t("startup.manager.createConnection")}</span>
          </button>

          <button
            type="button"
            className="startup-manager-search-add secondary"
            onClick={onOpenDatabaseFile}
            aria-label={t("menu.item.openDatabaseFile")}
            title={t("menu.item.openDatabaseFile")}
          >
            <FolderOpen className="w-4 h-4" />
          </button>

          <button
            type="button"
            className="startup-manager-search-add secondary"
            onClick={onPingAll}
            disabled={isPingingAll || filteredConnections.length === 0}
            aria-label={pingAllCopy.action}
            title={pingAllCopy.action}
          >
            {isPingingAll ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Activity className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      <div className="startup-manager-search-row">
        <div className="startup-manager-search">
          <Search className="w-4 h-4 text-[var(--text-muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("startup.manager.searchPlaceholder")}
          />
        </div>

        <div
          className="connection-layout-toggle startup-manager-layout-toggle"
          role="group"
          aria-label={t("connections.layout")}
        >
          <button
            type="button"
            className={`connection-layout-btn ${layoutMode === "stacked" ? "active" : ""}`}
            onClick={() => onLayoutModeChange("stacked")}
            title={t("connections.detailedList")}
            aria-pressed={layoutMode === "stacked"}
          >
            <LayoutList className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className={`connection-layout-btn ${layoutMode === "grid" ? "active" : ""}`}
            onClick={() => onLayoutModeChange("grid")}
            title={t("connections.compactGrid")}
            aria-pressed={layoutMode === "grid"}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="startup-manager-content">
        <div
          ref={listRef}
          className={`startup-manager-list ${layoutMode}`}
          data-tour="connection-list"
        >
          {flatItems.length === 0 ? (
            <div className="startup-manager-empty">
              <Database className="w-8 h-8 opacity-35" />
              <strong>{t("startup.manager.noConnections")}</strong>
              <p>{t("startup.manager.noConnectionsDescription")}</p>
              {showEmptyStateCtas ? (
                <>
                  <button type="button" className="btn btn-primary" onClick={onNewConnection}>
                    <Plus className="w-4 h-4" />
                    <span>{t("startup.manager.createConnection")}</span>
                  </button>
                  <button
                    type="button"
                    className="startup-manager-sample-card"
                    data-tour="startup-sample-db"
                    onClick={onCreateSample}
                    disabled={isCreatingSample || isConnecting}
                  >
                    {isCreatingSample ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Sparkles className="w-4 h-4" />
                    )}
                    <span className="startup-manager-sample-card-copy">
                      <strong>{sampleCopy.title}</strong>
                      <span>{sampleCopy.description}</span>
                    </span>
                    <span className="startup-manager-sample-card-action">
                      {isCreatingSample ? sampleCopy.creating : sampleCopy.action}
                    </span>
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={onImportConnections}>
                    <FileUp className="w-4 h-4" />
                    <span>{importCtaCopy.action}</span>
                  </button>
                </>
              ) : null}
            </div>
          ) : (
            flatItems.map((item) => {
              if (item.type === "group-header") {
                const group = groups.find((g) => g.id === item.groupId)!;
                return (
                  <ConnectionGroupHeader
                    key={`group-${item.groupId!}`}
                    group={group}
                    count={item.count!}
                    isCollapsed={collapsedGroupIds.has(item.groupId!)}
                    onToggle={() => onToggleGroup(item.groupId!)}
                    onRename={(name) => onRenameGroup(item.groupId!, name)}
                    onChangeColor={(color) => onChangeGroupColor(item.groupId!, color)}
                    onDelete={() => onDeleteGroup(item.groupId!)}
                  />
                );
              }

              const conn = item.connection!;
              const isConnected = connectedIds.has(conn.id);
              const isActive = activeConnectionId === conn.id;
              const isBusy = isConnecting && selectedConnectionId === conn.id;
              const tag = tags.find((t2) => t2.id === conn.tagId);
              const env = detectEnvironment(conn.host, conn.name);
              const envBadge = getEnvironmentBadge(env, {
                prod: "prod",
                staging: "staging",
                local: "local",
                ssh: "ssh",
              });

              return (
                <ConnectionRow
                  key={conn.id}
                  data={{
                    connection: conn,
                    isSelected: selectedConnectionId === conn.id,
                    isConnected,
                    isActive,
                    isBusy,
                    isGridLayout: layoutMode === "grid",
                    statusLabel: isBusy
                      ? t("common.loading")
                      : isActive
                        ? t("common.active")
                        : isConnected
                          ? t("common.connected")
                          : t("common.saved"),
                    dbInfo: getDbInfo(conn.db_type),
                    endpointLabel: buildEndpointLabel(
                      conn.db_type,
                      conn.host,
                      conn.port,
                      conn.file_path,
                    ),
                    databaseLabel: buildDatabaseLabel(conn.db_type, conn.database, conn.username),
                    engineLabel: conn.db_type.toUpperCase(),
                    secondaryBadgeLabel: buildSecondaryBadgeLabel(conn.db_type, !!conn.use_ssl),
                  }}
                  onClick={() => {
                    onSelectConnection(conn.id);
                    void onConnect(conn);
                  }}
                  onDelete={() => onDeleteConnection(conn)}
                  onRename={(name) => onRenameConnection(conn, name)}
                  renameLabel={t("common.rename")}
                  deleteLabel={t("connections.delete")}
                  onMouseEnter={(e) => onHover(e, conn.id)}
                  onMouseLeave={onLeaveHover}
                  tagName={tag?.name}
                  tagColor={tag?.color}
                  envBadge={envBadge}
                  ping={pingResults.get(conn.id)}
                  pingOkLabel={pingAllCopy.reachable}
                  pingFailLabel={pingAllCopy.unreachable}
                  onContextMenu={(e) => openContextMenu(e, conn.id)}
                  renameNonce={renameRequest?.id === conn.id ? renameRequest.nonce : undefined}
                />
              );
            })
          )}
        </div>
      </div>

      {contextMenu && contextMenuConnection ? (
        <div
          className="startup-connection-context-menu"
          style={{
            left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 240)),
            top: Math.max(
              8,
              Math.min(contextMenu.y, window.innerHeight - (groups.length * 34 + 200)),
            ),
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {isNamingGroup ? (
            <div className="startup-connection-context-new-group">
              <input
                type="text"
                autoFocus
                value={newGroupName}
                placeholder={groupsCopy.newGroupPlaceholder}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") submitNewGroup();
                  if (e.key === "Escape") closeContextMenu();
                }}
              />
              <button type="button" disabled={!newGroupName.trim()} onClick={submitNewGroup}>
                {groupsCopy.create}
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="startup-connection-group-menu-item"
                onClick={() => {
                  setRenameRequest({
                    id: contextMenu.connectionId,
                    nonce: Date.now(),
                  });
                  closeContextMenu();
                }}
              >
                {t("common.rename")}
              </button>

              <div className="startup-connection-context-label">{groupsCopy.moveToGroup}</div>
              {groups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className="startup-connection-group-menu-item"
                  onClick={() => {
                    onAssignToGroup(contextMenu.connectionId, group.id);
                    closeContextMenu();
                  }}
                >
                  <span
                    className="startup-connection-group-dot"
                    style={{ backgroundColor: group.color }}
                  />
                  <span className="startup-connection-context-item-label">{group.name}</span>
                  {contextMenuConnection.groupId === group.id ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : null}
                </button>
              ))}
              {contextMenuConnection.groupId ? (
                <button
                  type="button"
                  className="startup-connection-group-menu-item"
                  onClick={() => {
                    onAssignToGroup(contextMenu.connectionId, null);
                    closeContextMenu();
                  }}
                >
                  {groupsCopy.ungrouped}
                </button>
              ) : null}
              <button
                type="button"
                className="startup-connection-group-menu-item"
                onClick={() => setIsNamingGroup(true)}
              >
                <FolderPlus className="w-3.5 h-3.5" />
                <span className="startup-connection-context-item-label">{groupsCopy.newGroup}</span>
              </button>

              <button
                type="button"
                className="startup-connection-group-menu-item danger"
                onClick={() => {
                  onDeleteConnection(contextMenuConnection);
                  closeContextMenu();
                }}
              >
                {t("connections.delete")}
              </button>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

// ─── Flat list builder ────────────────────────────────────────────────────────

interface FlatItem {
  type: "group-header" | "connection";
  groupId?: string;
  count?: number;
  connection?: ConnectionConfig;
}

function buildFlatList({
  connections,
  groups,
  collapsedGroupIds,
  activeConnectionId,
  connectedIds,
}: {
  connections: ConnectionConfig[];
  groups: ConnectionGroup[];
  collapsedGroupIds: Set<string>;
  activeConnectionId: string | null;
  connectedIds: Set<string>;
}): FlatItem[] {
  const grouped = new Map<string, ConnectionConfig[]>();
  const ungrouped: ConnectionConfig[] = [];

  for (const conn of connections) {
    if (conn.groupId) {
      const existing = grouped.get(conn.groupId) ?? [];
      existing.push(conn);
      grouped.set(conn.groupId, existing);
    } else {
      ungrouped.push(conn);
    }
  }

  const sortConns = (conns: ConnectionConfig[]) =>
    [...conns].sort((a, b) => {
      const rankA = activeConnectionId === a.id ? 0 : connectedIds.has(a.id) ? 1 : 2;
      const rankB = activeConnectionId === b.id ? 0 : connectedIds.has(b.id) ? 1 : 2;
      if (rankA !== rankB) return rankA - rankB;
      const labelA = (a.name || a.database || a.host || a.file_path || "").toLocaleLowerCase();
      const labelB = (b.name || b.database || b.host || b.file_path || "").toLocaleLowerCase();
      return labelA.localeCompare(labelB);
    });

  const result: FlatItem[] = [];

  for (const group of groups) {
    const groupConns = grouped.get(group.id) ?? [];
    if (groupConns.length === 0) continue;

    result.push({ type: "group-header", groupId: group.id, count: groupConns.length });

    if (!collapsedGroupIds.has(group.id)) {
      for (const conn of sortConns(groupConns)) {
        result.push({ type: "connection", groupId: group.id, connection: conn });
      }
    }
  }

  for (const conn of sortConns(ungrouped)) {
    result.push({ type: "connection", connection: conn });
  }

  return result;
}
