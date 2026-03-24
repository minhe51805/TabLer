import { Database, LayoutGrid, LayoutList, Plus, Search } from "lucide-react";
import { useI18n } from "../../i18n";
import type { ConnectionConfig, ConnectionGroup, ConnectionLayoutMode, ConnectionTag } from "./types";
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
  filteredConnections: ConnectionConfig[];
  selectedConnectionId: string | null;
  activeConnectionId: string | null;
  connectedIds: Set<string>;
  groups: ConnectionGroup[];
  tags: ConnectionTag[];
  collapsedGroupIds: Set<string>;
  onSelectConnection: (id: string) => void;
  onConnect: (connection: ConnectionConfig) => void;
  onHover: (e: React.MouseEvent<HTMLButtonElement>, id: string) => void;
  onLeaveHover: () => void;
  onNewConnection: () => void;
  onToggleGroup: (groupId: string) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onChangeGroupColor: (groupId: string, color: string) => void;
  onDeleteGroup: (groupId: string) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
}

export function ConnectionListView({
  search,
  onSearchChange,
  layoutMode,
  onLayoutModeChange,
  filteredConnections,
  selectedConnectionId,
  activeConnectionId,
  connectedIds,
  groups,
  tags,
  collapsedGroupIds,
  onSelectConnection,
  onConnect,
  onHover,
  onLeaveHover,
  onNewConnection,
  onToggleGroup,
  onRenameGroup,
  onChangeGroupColor,
  onDeleteGroup,
  listRef,
}: Props) {
  const { t } = useI18n();

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
          <span className="startup-manager-kicker">{t("common.connections")}</span>
          <h3>{t("startup.manager.pickWorkspace")}</h3>
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

        <button
          type="button"
          className="startup-manager-search-add"
          onClick={onNewConnection}
          aria-label={t("startup.manager.createConnection")}
          title={t("startup.manager.createConnection")}
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="startup-manager-content">
        <div ref={listRef} className={`startup-manager-list ${layoutMode}`}>
          {flatItems.length === 0 ? (
            <div className="startup-manager-empty">
              <Database className="w-8 h-8 opacity-35" />
              <strong>{t("startup.manager.noConnections")}</strong>
              <p>{t("startup.manager.noConnectionsDescription")}</p>
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
                    isGridLayout: layoutMode === "grid",
                    statusLabel: isActive ? t("common.active") : isConnected ? t("common.connected") : t("common.saved"),
                    dbInfo: getDbInfo(conn.db_type),
                    endpointLabel: buildEndpointLabel(conn.db_type, conn.host, conn.port, conn.file_path),
                    databaseLabel: buildDatabaseLabel(conn.db_type, conn.database, conn.username),
                    engineLabel: conn.db_type.toUpperCase(),
                    secondaryBadgeLabel: buildSecondaryBadgeLabel(conn.db_type, !!conn.use_ssl),
                  }}
                  onClick={() => onSelectConnection(conn.id)}
                  onDoubleClick={() => onConnect(conn)}
                  onMouseEnter={(e) => onHover(e, conn.id)}
                  onMouseLeave={onLeaveHover}
                  tagName={tag?.name}
                  tagColor={tag?.color}
                  envBadge={envBadge}
                />
              );
            })
          )}
        </div>
      </div>
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
