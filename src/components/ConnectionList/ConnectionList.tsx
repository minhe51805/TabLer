import {
  Plus,
  Trash2,
  PlugZap,
  Database,
  Zap,
  ArrowRight,
  ArrowUpDown,
  LayoutList,
  LayoutGrid,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../stores/appStore";
import type { ConnectionConfig } from "../../types";
import { formatCountLabel, useI18n } from "../../i18n";

interface Props {
  onNewConnection: () => void;
}

type ConnectionLayoutMode = "stacked" | "inline";
type ConnectionSortMode = "connected" | "alpha";

const CONNECTION_LAYOUT_STORAGE_KEY = "tabler.connection-list-layout";
const CONNECTION_SORT_STORAGE_KEY = "tabler.connection-list-sort";
const MIN_CONNECTIONS_FOR_LAYOUT_TOGGLE = 3;

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

function getInitialLayoutMode(): ConnectionLayoutMode {
  if (typeof window === "undefined") return "stacked";

  const stored = window.localStorage.getItem(CONNECTION_LAYOUT_STORAGE_KEY);
  if (stored === "inline") return "inline";
  if (stored === "list") return "inline";
  return "stacked";
}

function getInitialSortMode(): ConnectionSortMode {
  if (typeof window === "undefined") return "connected";

  const stored = window.localStorage.getItem(CONNECTION_SORT_STORAGE_KEY);
  if (stored === "alpha") return "alpha";
  return "connected";
}

export function ConnectionList({ onNewConnection }: Props) {
  const { language, t } = useI18n();
  const {
    connections,
    activeConnectionId,
    connectedIds,
    connectSavedConnection,
    disconnectFromDatabase,
    deleteSavedConnection,
  } = useAppStore(
    useShallow((state) => ({
      connections: state.connections,
      activeConnectionId: state.activeConnectionId,
      connectedIds: state.connectedIds,
      connectSavedConnection: state.connectSavedConnection,
      disconnectFromDatabase: state.disconnectFromDatabase,
      deleteSavedConnection: state.deleteSavedConnection,
    }))
  );
  const connectedCount = connectedIds.size;
  const [layoutMode, setLayoutMode] = useState<ConnectionLayoutMode>(getInitialLayoutMode);
  const [sortMode, setSortMode] = useState<ConnectionSortMode>(getInitialSortMode);
  const showLayoutToggle = connections.length >= MIN_CONNECTIONS_FOR_LAYOUT_TOGGLE;
  const effectiveLayoutMode = showLayoutToggle ? layoutMode : "stacked";
  const sortedConnections = useMemo(() => {
    const getConnectionRank = (conn: ConnectionConfig) => {
      if (activeConnectionId === conn.id) return 0;
      if (connectedIds.has(conn.id)) return 1;
      return 2;
    };

    const getConnectionLabel = (conn: ConnectionConfig) =>
      (conn.name || conn.database || conn.host || conn.file_path || t("connections.untitled")).toLocaleLowerCase();

    return [...connections].sort((a, b) => {
      if (sortMode === "connected") {
        const rankDiff = getConnectionRank(a) - getConnectionRank(b);
        if (rankDiff !== 0) return rankDiff;
      }
      return getConnectionLabel(a).localeCompare(getConnectionLabel(b));
    });
  }, [activeConnectionId, connectedIds, connections, sortMode, t]);

  useEffect(() => {
    window.localStorage.setItem(CONNECTION_LAYOUT_STORAGE_KEY, layoutMode);
  }, [layoutMode]);

  useEffect(() => {
    window.localStorage.setItem(CONNECTION_SORT_STORAGE_KEY, sortMode);
  }, [sortMode]);

  const handleConnect = async (conn: ConnectionConfig) => {
    if (connectedIds.has(conn.id)) {
      useAppStore.setState({ activeConnectionId: conn.id });
      void useAppStore.getState().fetchDatabases(conn.id);
      if (conn.database) {
        useAppStore.setState({ currentDatabase: conn.database });
        void useAppStore.getState().fetchTables(conn.id, conn.database);
      }
    } else {
      await connectSavedConnection(conn.id);
    }
  };

  const handleDisconnect = async (e: React.MouseEvent, connId: string) => {
    e.stopPropagation();
    await disconnectFromDatabase(connId);
  };

  const handleDelete = async (e: React.MouseEvent, connId: string) => {
    e.stopPropagation();
    if (connectedIds.has(connId)) await disconnectFromDatabase(connId);
    await deleteSavedConnection(connId);
  };

  const defaultConnectionLabel = (conn: ConnectionConfig) =>
    conn.name || conn.host || conn.database || conn.file_path || t("connections.untitled");

  return (
    <div className="flex flex-col h-full">
      <div className="panel-header panel-header-rich connection-list-header">
        <div className="connection-list-header-main">
          <div className="connection-list-header-bar">
            <div className="connection-list-header-top">
              <div className="connection-list-header-copy">
                <span className="panel-kicker">{t("connections.kicker")}</span>
                <div className="connection-list-header-line">
                  <h2 className="connection-list-title" title={t("connections.savedTitle")}>
                    {t("connections.savedTitle")}
                  </h2>
                </div>
              </div>

              <div className="connection-list-header-controls">
                {showLayoutToggle && (
                    <div
                      className="connection-layout-toggle connection-list-layout-toggle"
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
                      className={`connection-layout-btn ${layoutMode === "inline" ? "active" : ""}`}
                      onClick={() => setLayoutMode("inline")}
                      title={t("connections.compactGrid")}
                      aria-pressed={layoutMode === "inline"}
                    >
                      <LayoutGrid className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="connection-list-sort-btn"
                  onClick={() => setSortMode((prev) => (prev === "connected" ? "alpha" : "connected"))}
                  title={
                    sortMode === "connected"
                      ? t("connections.sortTitleConnected")
                      : t("connections.sortTitleAlpha")
                  }
                >
                  <ArrowUpDown className="w-3 h-3" />
                  <span>{sortMode === "connected" ? t("connections.sortConnected") : t("connections.sortAlpha")}</span>
                </button>
              </div>
            </div>
            <div className="connection-list-header-bottom">
              <div className="connection-list-kicker-row">
                <span className="connection-list-mini-pill">
                  {formatCountLabel(language, connections.length, {
                    one: "saved",
                    other: "saved",
                    vi: "đã lưu",
                  })}
                </span>
                <span className="connection-list-mini-pill accent">
                  {formatCountLabel(language, connectedCount, {
                    one: "active",
                    other: "active",
                    vi: "đang hoạt động",
                  })}
                </span>
              </div>

              <div className="connection-list-header-toolbar">
                <button
                  onClick={onNewConnection}
                  className="connection-list-new-btn"
                  title={t("connections.newConnection")}
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{t("connections.new")}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto connection-list-scroll">
        {connections.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full px-6 text-center">
              <Database className="w-10 h-10 text-[var(--text-muted)] opacity-20 !mb-3" />
            <p className="text-sm text-[var(--text-muted)] !py-2">{t("connections.noSaved")}</p>
            <p className="text-xs text-[var(--text-muted)] opacity-60 mb-4">
              {t("connections.addToStart")}
            </p>
            <div className="connection-list-empty-actions">
              <button onClick={onNewConnection} className="btn btn-primary text-xs">
                <Plus className="w-3.5 h-3.5" />
                {t("connections.newConnection")}
              </button>
            </div>
            <p className="connection-list-empty-note">
              {t("connections.localDbNote")}
            </p>
          </div>
        ) : (
          <div className={`connection-list-stack ${effectiveLayoutMode}`}>
            {sortedConnections.map((conn) => {
              const isConnected = connectedIds.has(conn.id);
              const isActive = activeConnectionId === conn.id;
              const dbInfo = DB_LABELS[conn.db_type] || { abbr: "??", color: "var(--text-muted)" };
              const endpointLabel =
                conn.db_type === "sqlite"
                  ? conn.file_path || t("connections.sqliteFile")
                  : `${conn.host || "localhost"}${conn.port ? `:${conn.port}` : ""}`;
              const secondaryLabel =
                conn.db_type === "sqlite"
                  ? t("common.mode")
                  : conn.database
                    ? t("common.database")
                    : t("common.user");
              const secondaryValue =
                conn.db_type === "sqlite"
                  ? t("connections.localFileAccess")
                  : conn.database || conn.username || t("connections.credentialsSaved");
              const stateLabel = isActive
                ? t("common.active")
                : isConnected
                  ? t("common.connected")
                  : t("common.saved");
              const openLabel = isActive
                ? t("common.continue")
                : isConnected
                  ? t("common.open")
                  : t("common.connect");

              return (
                <div
                  key={conn.id}
                  onClick={() => handleConnect(conn)}
                  className={`connection-card ${effectiveLayoutMode} ${isActive ? "active" : ""} ${isConnected ? "online" : ""}`}
                >
                  <div className="connection-card-top">
                    <div className="connection-card-identity">
                      <div
                        className="connection-card-avatar"
                        style={{ backgroundColor: conn.color || dbInfo.color }}
                      >
                        {dbInfo.abbr}
                      </div>

                      <div className="connection-card-copy">
                        <div className="connection-card-title-row">
                          <span className="connection-card-title">
                            {defaultConnectionLabel(conn)}
                          </span>
                          {isConnected && (
                            <Zap className="connection-card-live-icon w-3.5 h-3.5 shrink-0 fill-current" />
                          )}
                        </div>

                        <div className="connection-card-status-row">
                          <span
                            className={`connection-card-status-dot ${isActive ? "active" : isConnected ? "online" : ""}`}
                          />
                          <span className="connection-card-state">{stateLabel}</span>
                        </div>
                      </div>
                    </div>

                    <div className="connection-card-tools">
                      {isConnected && (
                        <button
                          onClick={(e) => handleDisconnect(e, conn.id)}
                          className="connection-icon-btn accent"
                          title={t("connections.disconnect")}
                        >
                          <PlugZap className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={(e) => handleDelete(e, conn.id)}
                        className="connection-icon-btn danger"
                        title={t("connections.delete")}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="connection-card-metadata">
                    <div className="connection-meta-inline-item">
                      <span className="connection-meta-inline-label">
                        {conn.db_type === "sqlite" ? t("common.file") : t("common.endpoint")}
                      </span>
                      <span className="connection-meta-inline-value" title={endpointLabel}>
                        {endpointLabel}
                      </span>
                    </div>

                    <span className="connection-meta-inline-divider" />

                    <div className="connection-meta-inline-item">
                      <span className="connection-meta-inline-label">{secondaryLabel}</span>
                      <span className="connection-meta-inline-value" title={secondaryValue}>
                        {secondaryValue}
                      </span>
                    </div>
                  </div>

                  <div className="connection-card-footer">
                    <div className="connection-card-badges">
                      <span className="connection-type-pill">{conn.db_type}</span>
                      {conn.use_ssl && conn.db_type !== "sqlite" && (
                        <span className="connection-status-pill secure">SSL</span>
                      )}
                    </div>

                    <div className="connection-card-actions">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleConnect(conn);
                        }}
                        className="connection-open-btn full"
                        title={isConnected ? t("common.open") : t("common.connect")}
                      >
                        <span>{openLabel}</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                    <div className="connection-card-hover-panel" role="tooltip">
                      <div className="connection-card-hover-head">
                      <strong>{defaultConnectionLabel(conn)}</strong>
                      <span className={`connection-status-pill ${isActive ? "active" : isConnected ? "online" : ""}`}>
                        {stateLabel}
                      </span>
                    </div>
                    <div className="connection-card-hover-grid">
                      <div className="connection-card-hover-item">
                        <span>{conn.db_type === "sqlite" ? t("common.file") : t("common.endpoint")}</span>
                        <strong>{endpointLabel}</strong>
                      </div>
                      <div className="connection-card-hover-item">
                        <span>{secondaryLabel}</span>
                        <strong>{secondaryValue}</strong>
                      </div>
                    </div>
                    <div className="connection-card-hover-badges">
                      <span className="connection-type-pill">{conn.db_type}</span>
                      {conn.use_ssl && conn.db_type !== "sqlite" && (
                        <span className="connection-status-pill secure">SSL</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
