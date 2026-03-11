import {
  Plus,
  Trash2,
  PlugZap,
  Database,
  Zap,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import type { ConnectionConfig } from "../../types";

interface Props {
  onNewConnection: () => void;
}

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

export function ConnectionList({ onNewConnection }: Props) {
  const {
    connections,
    activeConnectionId,
    connectedIds,
    connectToDatabase,
    disconnectFromDatabase,
    deleteSavedConnection,
  } = useAppStore();

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
      {/* Header */}
      <div className="panel-header !px-4 !py-4">
        <span className="panel-header-title font-semibold text-[20px]">Connections</span>
        <button onClick={onNewConnection} className="panel-header-action" title="New Connection">
          <Plus className="!w-4 !h-4" />
        </button>
      </div>

      {/* Connection list */}
      <div className="flex-1 overflow-y-auto">
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
          <div className="!py-4 !px-2">
            {connections.map((conn) => {
              const isConnected = connectedIds.has(conn.id);
              const isActive = activeConnectionId === conn.id;
              const dbInfo = DB_LABELS[conn.db_type] || { abbr: "??", color: "var(--text-muted)" };

              return (
                <div
                  key={conn.id}
                  onClick={() => handleConnect(conn)}
                  className={`
                    group relative flex items-center gap-3 !px-3.5 !py-3 mx-1 mb-1 rounded-md cursor-pointer
                    transition-all duration-150
                    ${isActive
                      ? "bg-[var(--accent-dim)] ring-1 ring-[var(--accent)]/20"
                      : "hover:bg-[var(--bg-hover)]/50"
                    }
                  `}
                >
                  {/* Left color bar */}
                  <div
                    className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-md transition-opacity"
                    style={{
                      backgroundColor: conn.color || dbInfo.color,
                      opacity: isActive ? 1 : 0,
                    }}
                  />

                  {/* DB icon circle */}
                  <div
                      className="flex items-center justify-center w-8 h-8 rounded-md text-white text-[10px] font-bold shrink-0"
                    style={{ backgroundColor: dbInfo.color }}
                  >
                    {dbInfo.abbr}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-[var(--text-primary)] truncate">
                        {conn.name || conn.host || "Untitled"}
                      </span>
                      {isConnected && (
                        <Zap className="w-3 h-3 text-[var(--success)] shrink-0 fill-current" />
                      )}
                    </div>
                    <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
                      {conn.db_type === "sqlite"
                        ? conn.file_path || "SQLite"
                        : `${conn.host || "localhost"}:${conn.port}`}
                      {conn.database ? ` / ${conn.database}` : ""}
                    </div>
                  </div>

                  {/* Actions (on hover) */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    {isConnected && (
                      <button
                        onClick={(e) => handleDisconnect(e, conn.id)}
                        className="p-1.5 rounded-md hover:bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--warning)] transition-colors"
                        title="Disconnect"
                      >
                        <PlugZap className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      onClick={(e) => handleDelete(e, conn.id)}
                      className="p-1.5 rounded-md hover:bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--error)] transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
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
