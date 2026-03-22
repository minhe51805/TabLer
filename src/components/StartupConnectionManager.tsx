import {
  Database,
  LayoutGrid,
  LayoutList,
  Plus,
  Search,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { formatCountLabel, useI18n } from "../i18n";
import { useAppStore } from "../stores/appStore";
import type { ConnectionConfig } from "../types";

interface Props {
  onNewConnection: () => void;
  windowControls?: ReactNode;
}

const DB_LABELS: Record<string, { abbr: string; color: string }> = {
  mysql: { abbr: "Ms", color: "#c0392b" },
  mariadb: { abbr: "Mr", color: "#6c7a89" },
  sqlite: { abbr: "Sl", color: "#3498db" },
  duckdb: { abbr: "Du", color: "#2c3e50" },
  cassandra: { abbr: "Cs", color: "#27ae60" },
  cockroachdb: { abbr: "Cr", color: "#3ddc84" },
  snowflake: { abbr: "Nf", color: "#29b5e8" },
  postgresql: { abbr: "Pg", color: "#336791" },
  greenplum: { abbr: "Gp", color: "#2ecc71" },
  redshift: { abbr: "Rs", color: "#16a085" },
  mssql: { abbr: "Ss", color: "#7f8c8d" },
  redis: { abbr: "Re", color: "#e74c3c" },
  mongodb: { abbr: "Mg", color: "#27ae60" },
  vertica: { abbr: "Ve", color: "#95a5a6" },
  clickhouse: { abbr: "Ch", color: "#5b9bd5" },
  bigquery: { abbr: "Bq", color: "#8e44ad" },
  libsql: { abbr: "Ls", color: "#2ecc71" },
  cloudflared1: { abbr: "D1", color: "#f39c12" },
};

const APP_VERSION = "0.1.0";
const APP_DEVELOPER = "TabLer Team";
const STARTUP_CONNECTION_LAYOUT_STORAGE_KEY = "tabler.startup-connection-layout";

type ConnectionLayoutMode = "stacked" | "grid";

interface HoverPreviewState {
  connectionId: string;
  top: number;
  left: number;
  right: number;
}

function getLastPathSegment(value?: string | null) {
  if (!value) return "";
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
}

function getInitialLayoutMode(): ConnectionLayoutMode {
  if (typeof window === "undefined") return "stacked";

  const stored = window.localStorage.getItem(STARTUP_CONNECTION_LAYOUT_STORAGE_KEY);
  if (stored === "grid") return "grid";
  return "stacked";
}

export function StartupConnectionManager({
  onNewConnection,
  windowControls,
}: Props) {
  const { language, t } = useI18n();
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

  const [search, setSearch] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [layoutMode, setLayoutMode] = useState<ConnectionLayoutMode>(getInitialLayoutMode);
  const [hoverPreview, setHoverPreview] = useState<HoverPreviewState | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const sortedConnections = useMemo(() => {
    const getConnectionRank = (conn: ConnectionConfig) => {
      if (activeConnectionId === conn.id) return 0;
      if (connectedIds.has(conn.id)) return 1;
      return 2;
    };

    const getConnectionLabel = (conn: ConnectionConfig) =>
      (conn.name || conn.database || conn.host || conn.file_path || "").toLocaleLowerCase();

    return [...connections].sort((a, b) => {
      const rankDiff = getConnectionRank(a) - getConnectionRank(b);
      if (rankDiff !== 0) return rankDiff;
      return getConnectionLabel(a).localeCompare(getConnectionLabel(b));
    });
  }, [activeConnectionId, connectedIds, connections]);

  const filteredConnections = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return sortedConnections;

    return sortedConnections.filter((connection) => {
      const haystack = [
        connection.name,
        connection.host,
        connection.database,
        connection.username,
        connection.file_path,
        connection.db_type,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();

      return haystack.includes(needle);
    });
  }, [search, sortedConnections]);

  const selectedConnection =
    filteredConnections.find((connection) => connection.id === selectedConnectionId) ??
    filteredConnections[0] ??
    null;

  useEffect(() => {
    if (
      !selectedConnectionId ||
      !filteredConnections.some((connection) => connection.id === selectedConnectionId)
    ) {
      setSelectedConnectionId(filteredConnections[0]?.id ?? null);
    }
  }, [filteredConnections, selectedConnectionId]);

  useEffect(() => {
    window.localStorage.setItem(STARTUP_CONNECTION_LAYOUT_STORAGE_KEY, layoutMode);
  }, [layoutMode]);

  useEffect(() => {
    if (layoutMode !== "grid") {
      setHoverPreview(null);
    }
  }, [layoutMode]);

  useEffect(() => {
    const listElement = listRef.current;
    if (!listElement) return;

    const clearHoverPreview = () => setHoverPreview(null);

    listElement.addEventListener("scroll", clearHoverPreview);
    window.addEventListener("resize", clearHoverPreview);

    return () => {
      listElement.removeEventListener("scroll", clearHoverPreview);
      window.removeEventListener("resize", clearHoverPreview);
    };
  }, []);

  const handleOpenConnection = async (connection: ConnectionConfig) => {
    if (isConnecting) return;

    if (connectedIds.has(connection.id)) {
      useAppStore.setState({
        activeConnectionId: connection.id,
        currentDatabase: connection.database ?? null,
        ...(connection.database
          ? {}
          : {
              tables: [],
              schemaObjects: [],
            }),
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

  const handleConnectionHover = (
    event: ReactMouseEvent<HTMLButtonElement>,
    connectionId: string,
  ) => {
    if (layoutMode !== "grid") return;

    const rect = event.currentTarget.getBoundingClientRect();
    setHoverPreview({
      connectionId,
      top: rect.top,
      left: rect.left,
      right: rect.right,
    });
  };

  const hoveredConnection =
    hoverPreview &&
    (filteredConnections.find((connection) => connection.id === hoverPreview.connectionId) ??
      connections.find((connection) => connection.id === hoverPreview.connectionId));

  const hoveredConnectionPanel = useMemo(() => {
    if (!hoverPreview || !hoveredConnection || layoutMode !== "grid") return null;

    const popupWidth = 244;
    const popupHeight = 196;
    const viewportPadding = 16;
    const gap = 12;
    const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;

    let left = hoverPreview.right + gap;
    if (left + popupWidth > viewportWidth - viewportPadding) {
      left = Math.max(viewportPadding, hoverPreview.left - popupWidth - gap);
    }

    const top = Math.max(
      viewportPadding,
      Math.min(hoverPreview.top - 4, viewportHeight - popupHeight - viewportPadding),
    );

    const isConnected = connectedIds.has(hoveredConnection.id);
    const isActive = activeConnectionId === hoveredConnection.id;
    const statusLabel = isActive
      ? t("common.active")
      : isConnected
        ? t("common.connected")
        : t("common.saved");
    const endpointLabel =
      hoveredConnection.db_type === "sqlite"
        ? hoveredConnection.file_path || t("connections.sqliteFile")
        : `${hoveredConnection.host || "localhost"}${
            hoveredConnection.port ? `:${hoveredConnection.port}` : ""
          }`;
    const databaseLabel =
      hoveredConnection.db_type === "sqlite"
        ? t("connections.localFileAccess")
        : hoveredConnection.database ||
          hoveredConnection.username ||
          t("connections.credentialsSaved");

    return {
      connection: hoveredConnection,
      statusLabel,
      endpointLabel,
      databaseLabel,
      style: {
        top,
        left,
      },
      isActive,
      isConnected,
    };
  }, [activeConnectionId, connectedIds, connections, hoverPreview, hoveredConnection, layoutMode, t]);

  const connectionCountLabel = formatCountLabel(language, connections.length, {
    one: "saved",
    other: "saved",
    vi: "da luu",
  });
  const activeCountLabel = formatCountLabel(language, connectedIds.size, {
    one: "active",
    other: "active",
    vi: "dang hoat dong",
  });

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
          <section className="startup-manager-hero">
            <div className="startup-manager-hero-main">
              <div className="startup-manager-brand-icon">
                <Database className="w-8 h-8 text-[var(--accent)]" />
              </div>

              <div className="startup-manager-brand-copy">
                <h2 className="startup-manager-app-name">TabLer</h2>
                <p className="startup-manager-app-version">Version {APP_VERSION}</p>
                <p className="startup-manager-app-developer">{APP_DEVELOPER}</p>
              </div>
            </div>
          </section>

          <section className="startup-manager-browser">
            <div className="startup-manager-browser-head">
              <div className="startup-manager-browser-copy">
                <span className="startup-manager-kicker">{t("common.connections")}</span>
                <h3>{t("startup.manager.pickWorkspace")}</h3>
              </div>
              <div className="startup-manager-stats">
                <span className="startup-manager-pill">{connectionCountLabel}</span>
                <span className="startup-manager-pill accent">{activeCountLabel}</span>
              </div>
            </div>

            <div className="startup-manager-search-row">
              <div className="startup-manager-search">
                <Search className="w-4 h-4 text-[var(--text-muted)]" />
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
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
                  onClick={() => setLayoutMode("stacked")}
                  title={t("connections.detailedList")}
                  aria-pressed={layoutMode === "stacked"}
                >
                  <LayoutList className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  className={`connection-layout-btn ${layoutMode === "grid" ? "active" : ""}`}
                  onClick={() => setLayoutMode("grid")}
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
                {filteredConnections.length === 0 ? (
                  <div className="startup-manager-empty">
                    <Database className="w-8 h-8 opacity-35" />
                    <strong>{t("startup.manager.noConnections")}</strong>
                    <p>{t("startup.manager.noConnectionsDescription")}</p>
                  </div>
                ) : (
                  filteredConnections.map((connection) => {
                    const isGridLayout = layoutMode === "grid";
                    const isConnected = connectedIds.has(connection.id);
                    const isActive = activeConnectionId === connection.id;
                    const statusLabel = isActive
                      ? t("common.active")
                      : isConnected
                        ? t("common.connected")
                        : t("common.saved");
                    const dbInfo = DB_LABELS[connection.db_type] || {
                      abbr: "??",
                      color: "var(--text-muted)",
                    };
                    const endpointLabel =
                      connection.db_type === "sqlite"
                        ? getLastPathSegment(connection.file_path) || t("connections.sqliteFile")
                        : `${connection.host || "localhost"}${connection.port ? `:${connection.port}` : ""}`;
                    const databaseLabel =
                      connection.db_type === "sqlite"
                        ? t("connections.localFileAccess")
                        : connection.database ||
                          connection.username ||
                          t("connections.credentialsSaved");
                    const engineLabel = connection.db_type.toUpperCase();
                    const secondaryBadgeLabel =
                      connection.db_type === "sqlite"
                        ? t("startup.manager.localBadge")
                        : connection.use_ssl
                          ? "SSL"
                          : null;

                    return (
                      <button
                        key={connection.id}
                        type="button"
                        className={`startup-connection-row ${
                          selectedConnection?.id === connection.id ? "active" : ""
                        }`}
                        onClick={() => setSelectedConnectionId(connection.id)}
                        onDoubleClick={() => void handleOpenConnection(connection)}
                        onMouseEnter={(event) => handleConnectionHover(event, connection.id)}
                        onMouseLeave={() => setHoverPreview(null)}
                      >
                        <div
                          className="startup-connection-side"
                        >
                          <div
                            className="startup-connection-avatar"
                            style={{ backgroundColor: connection.color || dbInfo.color }}
                          >
                            {dbInfo.abbr}
                          </div>

                          {isGridLayout && secondaryBadgeLabel ? (
                            <div className="startup-connection-side-badges">
                              <span className="startup-connection-badge accent startup-connection-side-badge">
                                {secondaryBadgeLabel}
                              </span>
                            </div>
                          ) : null}
                        </div>

                        <div className="startup-connection-copy">
                          <div className="startup-connection-title-row">
                            <strong className="startup-connection-title">
                              {connection.name || t("connections.untitled")}
                            </strong>
                            <span
                              className={`startup-connection-status ${
                                isActive ? "active" : isConnected ? "connected" : ""
                              }`}
                            >
                              {statusLabel}
                            </span>
                          </div>

                          <span
                            className="startup-connection-meta"
                            title={
                              isGridLayout
                                ? `${endpointLabel}\n${databaseLabel}`
                                : `${endpointLabel} • ${databaseLabel}`
                            }
                          >
                            {isGridLayout ? endpointLabel : `${endpointLabel} • ${databaseLabel}`}
                          </span>

                          {isGridLayout ? (
                            <span className="startup-connection-meta secondary" title={databaseLabel}>
                              {databaseLabel}
                            </span>
                          ) : null}

                          {isGridLayout ? (
                            <div className="startup-connection-footer">
                              <span className="startup-connection-badge engine">{engineLabel}</span>
                            </div>
                          ) : null}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </section>
        </div>

        {hoveredConnectionPanel ? (
          <div
            className="startup-connection-floating-popover"
            style={{
              top: `${hoveredConnectionPanel.style.top}px`,
              left: `${hoveredConnectionPanel.style.left}px`,
            }}
          >
            <div className="startup-connection-hover-head">
              <strong>
                {hoveredConnectionPanel.connection.name || t("connections.untitled")}
              </strong>
              <span
                className={`startup-connection-status ${
                  hoveredConnectionPanel.isActive
                    ? "active"
                    : hoveredConnectionPanel.isConnected
                      ? "connected"
                      : ""
                }`}
              >
                {hoveredConnectionPanel.statusLabel}
              </span>
            </div>

            <div className="startup-connection-hover-grid">
              <div className="startup-connection-hover-item">
                <span>{t("common.endpoint")}</span>
                <strong>{hoveredConnectionPanel.endpointLabel}</strong>
              </div>
              <div className="startup-connection-hover-item">
                <span>{t("common.database")}</span>
                <strong>{hoveredConnectionPanel.databaseLabel}</strong>
              </div>
              {hoveredConnectionPanel.connection.username ? (
                <div className="startup-connection-hover-item">
                  <span>{t("common.user")}</span>
                  <strong>{hoveredConnectionPanel.connection.username}</strong>
                </div>
              ) : null}
            </div>

            <div className="startup-connection-hover-badges">
              <span className="startup-connection-badge">
                {hoveredConnectionPanel.connection.db_type.toUpperCase()}
              </span>
              {hoveredConnectionPanel.connection.use_ssl ? (
                <span className="startup-connection-badge accent">SSL</span>
              ) : null}
              {hoveredConnectionPanel.connection.db_type === "sqlite" ? (
                <span className="startup-connection-badge accent">
                  {t("connections.localFileAccess")}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
