import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Columns,
  Database,
  ChevronRight,
  ChevronDown,
  Eye,
  FileCode,
  GitBranch,
  Loader2,
  Plus,
  PlugZap,
  RefreshCw,
  Search,
  Table,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { CreateSchemaObjectModal } from "../CreateSchemaObjectModal/CreateSchemaObjectModal";
import type { DatabaseInfo, SchemaObjectInfo, TableInfo } from "../../types";

interface ExplorerSchemaSection {
  schemaName: string;
  tables: TableInfo[];
  views: SchemaObjectInfo[];
  triggers: SchemaObjectInfo[];
  routines: SchemaObjectInfo[];
}

function normalizeObjectSql(object: SchemaObjectInfo) {
  const qualifiedName = object.schema ? `${object.schema}.${object.name}` : object.name;
  const rawDefinition = object.definition?.trim();

  if (!rawDefinition) {
    return `-- ${object.object_type} ${qualifiedName}`;
  }

  const normalizedHead = rawDefinition.slice(0, 24).toUpperCase();
  if (normalizedHead.startsWith("CREATE ")) {
    return rawDefinition.endsWith(";") ? rawDefinition : `${rawDefinition};`;
  }

  if (object.object_type === "VIEW") {
    return `CREATE VIEW ${qualifiedName} AS\n${rawDefinition.replace(/;+\s*$/, "")};`;
  }

  return `-- ${object.object_type} ${qualifiedName}\n${rawDefinition}`;
}

function getLastPathSegment(value?: string | null) {
  if (!value) return "";
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
}

export function Sidebar() {
  const {
    activeConnectionId,
    connectedIds,
    connections,
    databases,
    currentDatabase,
    tables,
    schemaObjects,
    isLoadingTables,
    disconnectFromDatabase,
    fetchDatabases,
    fetchTables,
    fetchSchemaObjects,
    switchDatabase,
    addTab,
  } = useAppStore(
    useShallow((state) => ({
      activeConnectionId: state.activeConnectionId,
      connectedIds: state.connectedIds,
      connections: state.connections,
      databases: state.databases,
      currentDatabase: state.currentDatabase,
      tables: state.tables,
      schemaObjects: state.schemaObjects,
      isLoadingTables: state.isLoadingTables,
      disconnectFromDatabase: state.disconnectFromDatabase,
      fetchDatabases: state.fetchDatabases,
      fetchTables: state.fetchTables,
      fetchSchemaObjects: state.fetchSchemaObjects,
      switchDatabase: state.switchDatabase,
      addTab: state.addTab,
    }))
  );

  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [activeSchemaFilter, setActiveSchemaFilter] = useState<string>("all");
  const [isSchemaPickerOpen, setIsSchemaPickerOpen] = useState(false);
  const [showCreateWizard, setShowCreateWizard] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const schemaPickerRef = useRef<HTMLDivElement>(null);
  const activeConnection = connections.find((connection) => connection.id === activeConnectionId);
  const displayCurrentDatabase =
    activeConnection?.db_type === "sqlite" ? getLastPathSegment(currentDatabase) : currentDatabase || "";
  const compactDatabaseName =
    displayCurrentDatabase && displayCurrentDatabase.length > 40
      ? `${displayCurrentDatabase.slice(0, 24)}...${displayCurrentDatabase.slice(-12)}`
      : displayCurrentDatabase;
  const supportsCreateWizard =
    !!activeConnection &&
    ["postgresql", "greenplum", "cockroachdb", "redshift", "mysql", "mariadb", "sqlite"].includes(
      activeConnection.db_type
    );

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

  const handleTableClick = (table: Pick<TableInfo, "name" | "schema">) => {
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

  const handleStructureClick = (e: React.MouseEvent, table: Pick<TableInfo, "name" | "schema">) => {
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

  const handleObjectSqlClick = (e: React.MouseEvent, object: SchemaObjectInfo) => {
    e.stopPropagation();
    if (!activeConnectionId) return;

    const tabKind = object.object_type.toLowerCase();
    addTab({
      id: `query-${crypto.randomUUID()}`,
      type: "query",
      title: `${object.name} (${tabKind})`,
      connectionId: activeConnectionId,
      database: currentDatabase || undefined,
      content: normalizeObjectSql(object),
    });
  };

  const handleRefresh = async () => {
    if (!activeConnectionId) return;
    await fetchDatabases(activeConnectionId);
    if (currentDatabase) {
      await Promise.all([
        fetchTables(activeConnectionId, currentDatabase),
        fetchSchemaObjects(activeConnectionId, currentDatabase),
      ]);
    }
  };

  const handleDisconnect = async () => {
    if (!activeConnectionId) return;
    await disconnectFromDatabase(activeConnectionId);
  };

  const filteredTables = useMemo(() => {
    if (!search.trim()) return tables;
    const needle = search.trim().toLowerCase();
    return tables.filter((table) => {
      const qualifiedName = table.schema ? `${table.schema}.${table.name}` : table.name;
      return qualifiedName.toLowerCase().includes(needle);
    });
  }, [search, tables]);

  const filteredSchemaObjects = useMemo(() => {
    if (!search.trim()) return schemaObjects;
    const needle = search.trim().toLowerCase();
    return schemaObjects.filter((object) => {
      const qualifiedName = object.schema ? `${object.schema}.${object.name}` : object.name;
      const relatedTable = object.related_table || "";
      return (
        qualifiedName.toLowerCase().includes(needle) ||
        relatedTable.toLowerCase().includes(needle) ||
        object.object_type.toLowerCase().includes(needle)
      );
    });
  }, [schemaObjects, search]);

  const actualTables = useMemo(
    () => filteredTables.filter((table) => table.table_type !== "VIEW"),
    [filteredTables]
  );

  const schemaSections = useMemo<ExplorerSchemaSection[]>(() => {
    const groups = new Map<string, ExplorerSchemaSection>();

    const ensureGroup = (schemaName: string) => {
      if (!groups.has(schemaName)) {
        groups.set(schemaName, {
          schemaName,
          tables: [],
          views: [],
          triggers: [],
          routines: [],
        });
      }
      return groups.get(schemaName)!;
    };

    const sortedTables = [...actualTables].sort((left, right) => {
      const leftSchema = left.schema || "public";
      const rightSchema = right.schema || "public";
      if (leftSchema !== rightSchema) {
        return leftSchema.localeCompare(rightSchema);
      }
      return left.name.localeCompare(right.name);
    });

    for (const table of sortedTables) {
      ensureGroup(table.schema || "public").tables.push(table);
    }

    const sortedObjects = [...filteredSchemaObjects].sort((left, right) => {
      const leftSchema = left.schema || "public";
      const rightSchema = right.schema || "public";
      if (leftSchema !== rightSchema) {
        return leftSchema.localeCompare(rightSchema);
      }
      if (left.object_type !== right.object_type) {
        return left.object_type.localeCompare(right.object_type);
      }
      return left.name.localeCompare(right.name);
    });

    for (const object of sortedObjects) {
      const group = ensureGroup(object.schema || "public");
      if (object.object_type === "VIEW") {
        group.views.push(object);
      } else if (object.object_type === "TRIGGER") {
        group.triggers.push(object);
      } else {
        group.routines.push(object);
      }
    }

    return Array.from(groups.values()).sort((left, right) =>
      left.schemaName.localeCompare(right.schemaName)
    );
  }, [actualTables, filteredSchemaObjects]);

  const availableSchemaNames = useMemo(
    () => schemaSections.map((section) => section.schemaName),
    [schemaSections]
  );

  useEffect(() => {
    if (schemaSections.length === 0) {
      setActiveSchemaFilter("all");
      return;
    }

    const hasPublic = availableSchemaNames.includes("public");
    setActiveSchemaFilter((previous) => {
      if (previous !== "all" && availableSchemaNames.includes(previous)) {
        return previous;
      }
      if (hasPublic) return "public";
      return schemaSections[0]?.schemaName || "all";
    });
  }, [availableSchemaNames, schemaSections]);

  const filteredSchemaSections = useMemo(() => {
    if (activeSchemaFilter === "all") return schemaSections;
    return schemaSections.filter((section) => section.schemaName === activeSchemaFilter);
  }, [activeSchemaFilter, schemaSections]);

  const schemaFilterOptions = useMemo(
    () => [
      {
        value: "all",
        label: "All schemas",
        count: schemaSections.reduce(
          (total, section) =>
            total +
            section.tables.length +
            section.views.length +
            section.triggers.length +
            section.routines.length,
          0
        ),
      },
      ...schemaSections.map((section) => ({
        value: section.schemaName,
        label: section.schemaName,
        count:
          section.tables.length +
          section.views.length +
          section.triggers.length +
          section.routines.length,
      })),
    ],
    [schemaSections]
  );

  const hasSearch = search.trim().length > 0;
  const visibleTableCount = useMemo(
    () => filteredSchemaSections.reduce((total, section) => total + section.tables.length, 0),
    [filteredSchemaSections]
  );
  const visibleObjectCount = useMemo(
    () =>
      filteredSchemaSections.reduce(
        (total, section) => total + section.views.length + section.triggers.length + section.routines.length,
        0
      ),
    [filteredSchemaSections]
  );
  const visibleSchemaCount = filteredSchemaSections.length;

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

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!schemaPickerRef.current?.contains(event.target as Node)) {
        setIsSchemaPickerOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    setIsSchemaPickerOpen(false);
  }, [activeSchemaFilter, currentDatabase]);

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
        <div className="explorer-header-bar">
          <div className="explorer-header-identity">
            <div className="explorer-header-line">
              <h2 className="explorer-header-title">Explorer</h2>
            </div>

            <div className="explorer-header-context">
              <div className="explorer-workspace-pill" title={currentDatabase || undefined}>
                <span className="explorer-workspace-dot" />
                <span className="explorer-workspace-label">{compactDatabaseName || "Workspace"}</span>
              </div>
              <span className="explorer-header-summary-text">
                {visibleTableCount} tables | {visibleObjectCount} objects | {visibleSchemaCount}{" "}
                {visibleSchemaCount === 1 ? "schema" : "schemas"}
              </span>
            </div>
          </div>

          <div className="explorer-header-actions">
            {supportsCreateWizard && (
              <button
                type="button"
                onClick={() => setShowCreateWizard(true)}
                className="explorer-header-btn"
                title="Create table, view, or trigger"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Create</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => void handleDisconnect()}
              className="explorer-header-btn danger"
              title="Disconnect current database"
            >
              <PlugZap className="w-3.5 h-3.5" />
              <span>Disconnect</span>
            </button>

            <button
              type="button"
              onClick={() => void handleRefresh()}
              className="panel-header-action explorer-refresh-btn"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div className="explorer-search-panel">
        <div className="sidebar-search explorer-searchbar">
          <Search className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a table, view, trigger, or routine..."
            className="sidebar-search-input"
          />
        </div>
        <div className="explorer-search-hint">
          <span>
            {hasSearch
              ? `${visibleTableCount + visibleObjectCount} matches across ${visibleSchemaCount} schemas`
              : "Browse tables, views, triggers, and routines from the current database."}
          </span>
        </div>
      </div>

      <div className="explorer-tree-scroll">
        {databases.map((db) => {
          const isExpanded = expandedDbs.has(db.name);
          const isCurrent = currentDatabase === db.name;
          const tableCount = isCurrent ? tables.length : null;
          const displayDatabaseName =
            activeConnection?.db_type === "sqlite" ? getLastPathSegment(db.name) : db.name;

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
                  <div className="explorer-db-title-row">
                    <span className="explorer-db-name" title={db.name}>{displayDatabaseName}</span>
                    {isCurrent && <span className="explorer-db-pill active">Active</span>}
                  </div>
                  <span className="explorer-db-meta">
                    {isCurrent
                      ? `${tableCount ?? 0} tables ready to browse`
                      : "Switch workspace to browse objects"}
                  </span>
                </div>
                <div className="explorer-db-badges">
                  <span className="explorer-db-count">{tableCount ?? "--"}</span>
                  {db.size && <span className="explorer-db-pill">{db.size}</span>}
                </div>
              </button>

              {isExpanded && isCurrent && (
                <div className="explorer-table-panel">
                  <div className="explorer-table-panel-head">
                    <div className="explorer-table-panel-copy">
                      <span>Database objects</span>
                      <span className="explorer-table-panel-caption">
                        {activeSchemaFilter === "all"
                          ? "Grouped by schema"
                          : `Showing ${activeSchemaFilter} by default`}
                      </span>
                    </div>
                    <span className="explorer-table-panel-total">
                      {hasSearch
                        ? `${visibleTableCount + visibleObjectCount} shown`
                        : `${visibleTableCount} tables | ${visibleObjectCount} objects`}
                    </span>
                  </div>

                  {availableSchemaNames.length > 1 && (
                    <div className="explorer-schema-toolbar">
                      <span className="explorer-schema-toolbar-label">Schema</span>
                      <div className="explorer-schema-picker" ref={schemaPickerRef}>
                        <button
                          type="button"
                          className={`explorer-schema-picker-trigger ${isSchemaPickerOpen ? "open" : ""}`}
                          onClick={() => setIsSchemaPickerOpen((open) => !open)}
                        >
                          <span className="explorer-schema-picker-value">
                            {activeSchemaFilter === "all" ? "All schemas" : activeSchemaFilter}
                          </span>
                          <ChevronDown className={`w-3.5 h-3.5 explorer-schema-picker-chevron ${isSchemaPickerOpen ? "open" : ""}`} />
                        </button>

                        {isSchemaPickerOpen && (
                          <div className="explorer-schema-picker-menu">
                            {schemaFilterOptions.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                className={`explorer-schema-picker-option ${activeSchemaFilter === option.value ? "active" : ""}`}
                                onClick={() => setActiveSchemaFilter(option.value)}
                              >
                                <span className="explorer-schema-picker-option-label">{option.label}</span>
                                <span className="explorer-schema-picker-option-count">{option.count}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {isLoadingTables ? (
                    <div className="explorer-table-status">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Loading database objects...
                    </div>
                  ) : filteredSchemaSections.length === 0 ? (
                    <div className="explorer-table-status empty">
                      {search ? "No objects match filter" : "No objects found"}
                    </div>
                  ) : (
                    filteredSchemaSections.map((section) => (
                      <section key={section.schemaName} className="explorer-schema-group">
                        <div className="explorer-schema-head">
                          <span className="explorer-schema-name">{section.schemaName}</span>
                          <span className="explorer-schema-count">
                            {section.tables.length + section.views.length + section.triggers.length + section.routines.length}
                          </span>
                        </div>

                        <div className="explorer-schema-list">
                          {section.tables.length > 0 && (
                            <div className="explorer-object-group">
                              <div className="explorer-object-group-head">Tables</div>
                              {section.tables.map((table) => (
                                <div
                                  key={`table-${section.schemaName}-${table.name}`}
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
                                        Open data rows
                                        {table.row_count != null
                                          ? ` | ${table.row_count.toLocaleString()} rows`
                                          : ""}
                                      </span>
                                    </div>
                                  </button>
                                  <button
                                    onClick={(e) => handleStructureClick(e, table)}
                                    className="explorer-structure-btn"
                                    title="View structure"
                                  >
                                    <Columns className="w-3.5 h-3.5" />
                                    <span>Schema</span>
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}

                          {section.views.length > 0 && (
                            <div className="explorer-object-group">
                              <div className="explorer-object-group-head">Views</div>
                              {section.views.map((view) => (
                                <div
                                  key={`view-${section.schemaName}-${view.name}`}
                                  className="explorer-table-row"
                                >
                                  <button
                                    onClick={() => handleTableClick({ name: view.name, schema: view.schema })}
                                    className="explorer-table-main"
                                  >
                                    <div className="explorer-table-icon">
                                      <Eye className="w-3.5 h-3.5 shrink-0" />
                                    </div>
                                    <div className="explorer-table-copy">
                                      <span className="explorer-table-name">{view.name}</span>
                                      <span className="explorer-table-meta">View</span>
                                    </div>
                                  </button>
                                  <button
                                    onClick={(e) =>
                                      handleStructureClick(e, { name: view.name, schema: view.schema })
                                    }
                                    className="explorer-structure-btn"
                                    title="View structure"
                                  >
                                    <Columns className="w-3.5 h-3.5" />
                                    <span>Schema</span>
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}

                          {section.triggers.length > 0 && (
                            <div className="explorer-object-group">
                              <div className="explorer-object-group-head">Triggers</div>
                              {section.triggers.map((trigger) => (
                                <div
                                  key={`trigger-${section.schemaName}-${trigger.name}`}
                                  className="explorer-table-row explorer-object-row"
                                >
                                  <div className="explorer-table-main static">
                                    <div className="explorer-table-icon">
                                      <GitBranch className="w-3.5 h-3.5 shrink-0" />
                                    </div>
                                    <div className="explorer-table-copy">
                                      <span className="explorer-table-name">{trigger.name}</span>
                                      <span className="explorer-table-meta">
                                        {trigger.related_table || "Trigger"}
                                      </span>
                                    </div>
                                  </div>
                                  <button
                                    onClick={(e) => handleObjectSqlClick(e, trigger)}
                                    className="explorer-structure-btn"
                                    title="Open SQL"
                                  >
                                    <FileCode className="w-3.5 h-3.5" />
                                    <span>SQL</span>
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}

                          {section.routines.length > 0 && (
                            <div className="explorer-object-group">
                              <div className="explorer-object-group-head">Routines</div>
                              {section.routines.map((routine) => (
                                <div
                                  key={`routine-${section.schemaName}-${routine.name}`}
                                  className="explorer-table-row explorer-object-row"
                                >
                                  <div className="explorer-table-main static">
                                    <div className="explorer-table-icon">
                                      <FileCode className="w-3.5 h-3.5 shrink-0" />
                                    </div>
                                    <div className="explorer-table-copy">
                                      <span className="explorer-table-name">{routine.name}</span>
                                      <span className="explorer-table-meta">{routine.object_type}</span>
                                    </div>
                                  </div>
                                  <button
                                    onClick={(e) => handleObjectSqlClick(e, routine)}
                                    className="explorer-structure-btn"
                                    title="Open SQL"
                                  >
                                    <FileCode className="w-3.5 h-3.5" />
                                    <span>SQL</span>
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </section>
                    ))
                  )}
                </div>
              )}
            </section>
          );
        })}

        {databases.length === 0 && <div className="explorer-empty">No databases found</div>}
      </div>

      {showCreateWizard && activeConnection && (
        <CreateSchemaObjectModal
          dbType={activeConnection.db_type}
          database={currentDatabase || undefined}
          tables={tables}
          onClose={() => setShowCreateWizard(false)}
          onCreateDraft={(title, sql) => {
            if (!activeConnectionId) return;
            addTab({
              id: `query-${crypto.randomUUID()}`,
              type: "query",
              title,
              connectionId: activeConnectionId,
              database: currentDatabase || undefined,
              content: sql,
            });
          }}
        />
      )}
    </div>
  );
}
