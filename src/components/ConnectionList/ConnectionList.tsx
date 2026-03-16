import {
  Plus,
  Trash2,
  PlugZap,
  Database,
  Zap,
  ArrowRight,
  LayoutGrid,
  LayoutList,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import type { ConnectionConfig } from "../../types";

interface Props {
  onNewConnection: () => void;
}

type ConnectionLayoutMode = "stacked" | "inline";

const CONNECTION_LAYOUT_STORAGE_KEY = "tabler.connection-list-layout";
const MIN_CONNECTIONS_FOR_LAYOUT_TOGGLE = 3;

const DB_LABELS: Record<string, { abbr: string; color: string }> = {
  mysql:      { abbr: "Ms", color: "#c0392b" },
  mariadb:    { abbr: "Mr", color: "#6c7a89" },
  sqlite:     { abbr: "Sl", color: "#3498db" },
  duckdb:     { abbr: "Du", color: "#2c3e50" },
  cassandra:  { abbr: "Cs", color: "#27ae60" },
  cockroachdb:{ abbr: "Cr", color: "#3ddc84" },
  snowflake:  { abbr: "Nf", color: "#29b5e8" },
  postgresql: { abbr: "Pg", color: "#336791" },
  greenplum:  { abbr: "Gp", color: "#2ecc71" },
  redshift:   { abbr: "Rs", color: "#16a085" },
  mssql:      { abbr: "Ss", color: "#7f8c8d" },
  redis:      { abbr: "Re", color: "#e74c3c" },
  mongodb:    { abbr: "Mg", color: "#27ae60" },
  vertica:    { abbr: "Ve", color: "#95a5a6" },
  clickhouse: { abbr: "Ch", color: "#5b9bd5" },
  bigquery:   { abbr: "Bq", color: "#8e44ad" },
  libsql:     { abbr: "Ls", color: "#2ecc71" },
  cloudflared1:{ abbr: "D1", color: "#f39c12" },
};

function getInitialLayoutMode(): ConnectionLayoutMode {
  if (typeof window === "undefined") return "stacked";

  const stored = window.localStorage.getItem(CONNECTION_LAYOUT_STORAGE_KEY);
  if (stored === "inline") return "inline";
  if (stored === "list") return "inline";
  return "stacked";
}

export function ConnectionList({ onNewConnection }: Props) {
  const {
    connections,
    activeConnectionId,
    connectedIds,
    connectToDatabase,
    disconnectFromDatabase,
    deleteSavedConnection,
  } = useAppStore();
  const connectedCount = connectedIds.size;
  const [layoutMode, setLayoutMode] = useState<ConnectionLayoutMode>(getInitialLayoutMode);
  const showLayoutToggle = connections.length >= MIN_CONNECTIONS_FOR_LAYOUT_TOGGLE;
  const effectiveLayoutMode = showLayoutToggle ? layoutMode : "stacked";

  useEffect(() => {
    window.localStorage.setItem(CONNECTION_LAYOUT_STORAGE_KEY, layoutMode);
  }, [layoutMode]);

  const handleConnect = async (conn: ConnectionConfig) => {
    if (connectedIds.has(conn.id)) {
      useAppStore.setState({ activeConnectionId: conn.id });
      await useAppStore.getState().fetchDatabases(conn.id);
      if (conn.database) {
        useAppStore.setState({ currentDatabase: conn.database });
        await useAppStore.getState().fetchTables(conn.id, conn.database);
      }
    } else {
      await connectToDatabase(conn);
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

  return (
    <div className="flex flex-col h-full">
      <div className="panel-header panel-header-rich connection-list-header">
        <div className="connection-list-header-bar">
          <div className="connection-list-header-identity">
            <span className="panel-kicker">Connections</span>
            <div className="connection-list-header-line">
              <h2 className="connection-list-title">Saved connections</h2>
              <span className="connection-list-mini-pill">
                {connections.length} saved
              </span>
              <span className="connection-list-mini-pill accent">
                {connectedCount} active
              </span>
            </div>
          </div>
        </div>

        <div className={`connection-list-header-actions ${showLayoutToggle ? "" : "compact"}`}>
          {showLayoutToggle && (
            <div className="connection-layout-toggle" role="group" aria-label="Connection layout">
              <button
                type="button"
                className={`connection-layout-btn ${layoutMode === "stacked" ? "active" : ""}`}
                onClick={() => setLayoutMode("stacked")}
                title="Vertical layout"
                aria-pressed={layoutMode === "stacked"}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                className={`connection-layout-btn ${layoutMode === "inline" ? "active" : ""}`}
                onClick={() => setLayoutMode("inline")}
                title="Horizontal layout"
                aria-pressed={layoutMode === "inline"}
              >
                <LayoutList className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <button
            onClick={onNewConnection}
            className="panel-header-action connection-list-create-btn"
            title="New Connection"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto connection-list-scroll">
        {connections.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center">
            <Database className="w-10 h-10 text-[var(--text-muted)] opacity-20 !mb-3" />
            <p className="text-sm text-[var(--text-muted)] !py-2">No saved connections</p>
            <p className="text-xs text-[var(--text-muted)] opacity-60 mb-4">
              Add a connection to get started
            </p>
            <button onClick={onNewConnection} className="btn btn-primary text-xs">
              <Plus className="w-3.5 h-3.5" />
              New Connection
            </button>
          </div>
        ) : (
          <div className={`connection-list-stack ${effectiveLayoutMode}`}>
            {connections.map((conn) => {
              const isConnected = connectedIds.has(conn.id);
              const isActive = activeConnectionId === conn.id;
              const dbInfo = DB_LABELS[conn.db_type] || { abbr: "??", color: "var(--text-muted)" };
              const endpointLabel =
                conn.db_type === "sqlite"
                  ? conn.file_path || "SQLite file"
                  : `${conn.host || "localhost"}${conn.port ? `:${conn.port}` : ""}`;
              const secondaryLabel =
                conn.db_type === "sqlite"
                  ? "Mode"
                  : conn.database
                    ? "Database"
                    : "User";
              const secondaryValue =
                conn.db_type === "sqlite"
                  ? "Local file access"
                  : conn.database || conn.username || "Credentials saved";
              const stateLabel = isActive
                ? "Active"
                : isConnected
                  ? "Connected"
                  : "Saved";
              const openLabel = isActive
                ? "Continue"
                : isConnected
                  ? "Open"
                  : "Connect";

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
                            {conn.name || conn.host || "Untitled"}
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
                          title="Disconnect"
                        >
                          <PlugZap className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={(e) => handleDelete(e, conn.id)}
                        className="connection-icon-btn danger"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="connection-card-metadata">
                    <div className="connection-meta-tile">
                      <span className="connection-meta-label">
                        {conn.db_type === "sqlite" ? "File" : "Endpoint"}
                      </span>
                      <span className="connection-meta-value" title={endpointLabel}>
                        {endpointLabel}
                      </span>
                    </div>

                    <div className="connection-meta-tile">
                      <span className="connection-meta-label">{secondaryLabel}</span>
                      <span className="connection-meta-value" title={secondaryValue}>
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
                      <span
                        className={`connection-status-pill ${isActive ? "active" : isConnected ? "online" : ""}`}
                      >
                        {isActive ? "Active" : isConnected ? "Connected" : "Saved"}
                      </span>
                    </div>

                    <div className="connection-card-actions">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleConnect(conn);
                        }}
                        className="connection-open-btn full"
                        title={isConnected ? "Open workspace" : "Connect"}
                      >
                        <span>{openLabel}</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
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
