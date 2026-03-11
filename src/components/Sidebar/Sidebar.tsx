import { useState } from "react";
import {
  Database,
  Table,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Loader2,
  Columns,
  Search,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import type { DatabaseInfo, TableInfo } from "../../types";

export function Sidebar() {
  const {
    activeConnectionId,
    connectedIds,
    databases,
    currentDatabase,
    tables,
    isLoadingTables,
    fetchDatabases,
    switchDatabase,
    addTab,
  } = useAppStore();

  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const toggleDb = async (db: DatabaseInfo) => {
    if (!activeConnectionId) return;
    const next = new Set(expandedDbs);
    if (next.has(db.name)) {
      next.delete(db.name);
    } else {
      next.add(db.name);
      await switchDatabase(activeConnectionId, db.name);
    }
    setExpandedDbs(next);
  };

  const handleTableClick = (table: TableInfo) => {
    if (!activeConnectionId) return;
    const qualifiedName = table.schema ? `${table.schema}.${table.name}` : table.name;
    addTab({
      id: `table-${activeConnectionId}-${currentDatabase}-${qualifiedName}`,
      type: "table",
      title: table.name,
      connectionId: activeConnectionId,
      tableName: qualifiedName,
      database: currentDatabase || undefined,
    });
  };

  const handleStructureClick = (e: React.MouseEvent, table: TableInfo) => {
    e.stopPropagation();
    if (!activeConnectionId) return;
    const qualifiedName = table.schema ? `${table.schema}.${table.name}` : table.name;
    addTab({
      id: `structure-${activeConnectionId}-${currentDatabase}-${qualifiedName}`,
      type: "structure",
      title: `${table.name} (structure)`,
      connectionId: activeConnectionId,
      tableName: qualifiedName,
      database: currentDatabase || undefined,
    });
  };

  const handleRefresh = async () => {
    if (!activeConnectionId) return;
    await fetchDatabases(activeConnectionId);
  };

  const filteredTables = search
    ? tables.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()))
    : tables;

  if (!activeConnectionId || !connectedIds.has(activeConnectionId)) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 text-center text-[var(--text-muted)]">
        <Database className="w-12 h-12 mb-4 opacity-15" />
        <p className="text-sm font-medium opacity-60">No active connection</p>
        <p className="text-xs mt-1.5 opacity-40">Connect to a database to explore tables</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="panel-header">
        <span className="panel-header-title">Explorer</span>
        <button onClick={handleRefresh} className="panel-header-action" title="Refresh">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="!px-3 !py-3 border-b border-[var(--border-color)] bg-[rgba(255,255,255,0.015)]">
        <div className="sidebar-search">
          <Search className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter tables..."
            className="sidebar-search-input"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto !py-2 !px-2">
        {databases.map((db) => {
          const isExpanded = expandedDbs.has(db.name);
          const isCurrent = currentDatabase === db.name;

          return (
            <div key={db.name} className="!p-1">
              <button
                onClick={() => toggleDb(db)}
                className={`
                  flex items-center !gap-2 w-full !px-3 !py-2 text-left transition-all text-[13px] rounded-sm border
                  ${isCurrent
                    ? "text-[var(--accent-hover)] bg-[var(--accent-dim)] border-[rgba(110,168,255,0.3)]"
                    : "text-[var(--text-primary)] hover:bg-[var(--bg-hover)]/30 border-transparent hover:border-white/10"
                  }
                `}
              >
                {isExpanded ? (
                  <ChevronDown className="!w-4 !h-4 shrink-0 text-[var(--text-muted)]" />
                ) : (
                  <ChevronRight className="!w-4 !h-4 shrink-0 text-[var(--text-muted)]" />
                )}
                <Database className="!w-4 !h-4 shrink-0 text-[var(--accent)]" />
                <span className="truncate flex-1">{db.name}</span>
                {db.size && (
                  <span className="text-[10px] text-[var(--text-muted)] !ml-auto shrink-0">
                    {db.size}
                  </span>
                )}
              </button>

              {isExpanded && isCurrent && (
                <div className="pb-1 mt-1">
                  {isLoadingTables ? (
                    <div className="flex items-center gap-2 px-4 py-2 ml-4 text-xs text-[var(--text-muted)]">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Loading tables...
                    </div>
                  ) : filteredTables.length === 0 ? (
                    <div className="px-4 py-2 ml-4 text-xs text-[var(--text-muted)] opacity-60">
                      {search ? "No tables match filter" : "No tables found"}
                    </div>
                  ) : (
                    filteredTables.map((table) => (
                      <div
                        key={`${table.schema || "public"}.${table.name}`}
                        onClick={() => handleTableClick(table)}
                        className="group flex items-center gap-2 w-full pl-8 pr-2! !py-[6px] text-left
                          hover:bg-[var(--bg-hover)]/25 rounded-md cursor-pointer transition-colors text-[13px]"
                      >
                        <Table className="w-3.5 h-3.5 shrink-0 text-[var(--success)] opacity-70" />
                        <span className="truncate flex-1 text-[var(--text-secondary)]">
                          {table.name}
                        </span>

                        <button
                          onClick={(e) => handleStructureClick(e, table)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded-sm! hover:bg-[var(--bg-surface)]
                            text-[var(--text-muted)] hover:text-[var(--accent)] transition-all shrink-0"
                          title="View structure"
                        >
                          <Columns className="w-3 h-3" />
                        </button>

                        {table.row_count != null && (
                          <span className="text-[10px] text-[var(--text-muted)] tabular-nums shrink-0 group-hover:hidden">
                            {table.row_count.toLocaleString()}
                          </span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}

        {databases.length === 0 && (
          <div className="flex items-center justify-center h-20 text-xs text-[var(--text-muted)]">
            No databases found
          </div>
        )}
      </div>
    </div>
  );
}
