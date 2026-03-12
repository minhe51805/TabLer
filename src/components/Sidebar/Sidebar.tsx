import { useEffect, useRef, useState } from "react";
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
    fetchTables,
    switchDatabase,
    addTab,
  } = useAppStore();

  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const compactDatabaseName = currentDatabase && currentDatabase.length > 40
    ? `${currentDatabase.slice(0, 24)}...${currentDatabase.slice(-12)}`
    : currentDatabase;

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
    if (currentDatabase) {
      await fetchTables(activeConnectionId, currentDatabase);
    }
  };

  const filteredTables = search
    ? tables.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()))
    : tables;
  const hasSearch = search.trim().length > 0;
  const visibleTableCount = filteredTables.length;

  useEffect(() => {
    if (!currentDatabase) return;

    setExpandedDbs((prev) => {
      if (prev.has(currentDatabase)) return prev;
      const next = new Set(prev);
      next.add(currentDatabase);
      return next;
    });
  }, [currentDatabase]);

  useEffect(() => {
    const handleFocusSearch = () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };

    window.addEventListener("focus-explorer-search", handleFocusSearch);
    return () => window.removeEventListener("focus-explorer-search", handleFocusSearch);
  }, []);

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
    <div className="explorer-shell">
      <div className="panel-header panel-header-rich explorer-header">
        <div className="panel-header-copy">
          <span className="panel-kicker">Explorer</span>
          <h2 className="panel-title-lg">Database browser</h2>
          <p className="panel-subtitle" title={currentDatabase || undefined}>
            {currentDatabase
              ? `Browsing ${compactDatabaseName}. Open a table to inspect data or structure.`
              : "Select a database to browse its tables."}
          </p>
        </div>

        <div className="explorer-header-side">
          <div className="explorer-header-stats">
            <span className="explorer-stat-pill">
              {visibleTableCount} {hasSearch ? "shown" : "tables"}
            </span>
          </div>

          <button onClick={handleRefresh} className="panel-header-action explorer-refresh-btn" title="Refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="explorer-search-panel">
        <div className="sidebar-search">
          <Search className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a table in this database..."
            className="sidebar-search-input"
          />
        </div>
        <div className="explorer-search-hint">
          <span>{hasSearch ? `${visibleTableCount} matches` : "Open table data or inspect structure"}</span>
        </div>
      </div>

      <div className="explorer-tree-scroll">
        {databases.map((db) => {
          const isExpanded = expandedDbs.has(db.name);
          const isCurrent = currentDatabase === db.name;
          const tableCount = isCurrent ? tables.length : null;

          return (
            <section
              key={db.name}
              className={`explorer-db-section ${isCurrent ? "active" : ""}`}
            >
              <button
                onClick={() => toggleDb(db)}
                className={`explorer-db-button ${isCurrent ? "active" : ""}`}
              >
                {isExpanded ? (
                  <ChevronDown className="w-4 h-4 shrink-0 explorer-db-chevron" />
                ) : (
                  <ChevronRight className="w-4 h-4 shrink-0 explorer-db-chevron" />
                )}
                <div className="explorer-db-icon">
                  <Database className="w-4 h-4 shrink-0" />
                </div>
                <div className="explorer-db-copy">
                  <span className="explorer-db-name">{db.name}</span>
                  <span className="explorer-db-meta">
                    {isCurrent
                      ? `${tableCount ?? 0} tables ready to browse`
                      : "Switch workspace to browse tables"}
                  </span>
                </div>
                <div className="explorer-db-badges">
                  {isCurrent && <span className="explorer-db-pill active">Active</span>}
                  {db.size && <span className="explorer-db-pill">{db.size}</span>}
                </div>
              </button>

              {isExpanded && isCurrent && (
                <div className="explorer-table-panel">
                  <div className="explorer-table-panel-head">
                    <span>Tables</span>
                    <span>
                      {hasSearch ? `${visibleTableCount} of ${tables.length}` : `${tables.length} total`}
                    </span>
                  </div>
                  {isLoadingTables ? (
                    <div className="explorer-table-status">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Loading tables...
                    </div>
                  ) : filteredTables.length === 0 ? (
                    <div className="explorer-table-status empty">
                      {search ? "No tables match filter" : "No tables found"}
                    </div>
                  ) : (
                    filteredTables.map((table) => (
                      <div
                        key={`${table.schema || "public"}.${table.name}`}
                        className="explorer-table-row"
                      >
                        <button
                          onClick={() => handleTableClick(table)}
                          className="explorer-table-main"
                        >
                          <div className="explorer-table-icon">
                            <Table className="w-3.5 h-3.5 shrink-0" />
                          </div>
                          <div className="explorer-table-copy">
                            <span className="explorer-table-name">{table.name}</span>
                            <span className="explorer-table-meta">
                              {table.schema ? `Schema ${table.schema}` : "Open data rows"}
                              {table.row_count != null ? ` • ${table.row_count.toLocaleString()} rows` : ""}
                            </span>
                          </div>
                        </button>
                        <button
                          onClick={(e) => handleStructureClick(e, table)}
                          className="explorer-structure-btn"
                          title="View structure"
                        >
                          <Columns className="w-3.5 h-3.5" />
                          <span>Structure</span>
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </section>
          );
        })}

        {databases.length === 0 && (
          <div className="explorer-empty">
            No databases found
          </div>
        )}
      </div>
    </div>
  );
}
