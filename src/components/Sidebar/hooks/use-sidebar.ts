import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";

import { useAppStore } from "../../../stores/appStore";
import { useI18n } from "../../../i18n";
import { useEvent, EventCenter } from "../../../stores/event-center";
import {
  getQualifiedTableName,
  getQuotedQualifiedTableName,
  quoteIdentifier,
  normalizeObjectSql,
  copyToClipboard,
} from "../SidebarUtils";
import { emitAppToast } from "../../../utils/app-toast";
import {
  usePinnedTables,
  useSchemaSections,
  useExplorerSummary,
} from "./useTreeState";
import { EXPLORER_PINNED_TABLES_STORAGE_KEY } from "./useTreeState";
import type { DatabaseInfo, SchemaObjectInfo, TableInfo } from "../../../types";
import type { ExplorerContextMenuItem } from "../components/ContextMenu";
import {
  type FilterOperator,
  type FilterCondition,
  DEFAULT_FILTER_OPERATOR,
} from "../../../types/filter-presets";
import { useFilterPresetsStore } from "../../../stores/filterPresetsStore";

// ---------------------------------------------------------------------------
// Script builders
// ---------------------------------------------------------------------------

function buildOverviewScript(
  table: Pick<TableInfo, "name" | "schema">,
  dbType?: string,
) {
  const qualified = getQuotedQualifiedTableName(table, dbType);
  return `-- Overview for ${getQualifiedTableName(table)}
SELECT COUNT(*) AS total_rows FROM ${qualified};

SELECT *
FROM ${qualified}
LIMIT 100;`;
}

function buildSelectScript(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  const qualified = getQuotedQualifiedTableName(table, dbType);
  return `SELECT *
FROM ${qualified}
LIMIT 1000;`;
}

function buildInsertTemplate(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  const qualified = getQuotedQualifiedTableName(table, dbType);
  return `INSERT INTO ${qualified} (
  -- columns
)
VALUES (
  -- values
);`;
}

function buildUpdateTemplate(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  const qualified = getQuotedQualifiedTableName(table, dbType);
  return `UPDATE ${qualified}
SET
  -- column = value
WHERE
  -- condition
;`;
}

function buildDeleteTemplate(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  const qualified = getQuotedQualifiedTableName(table, dbType);
  return `DELETE FROM ${qualified}
WHERE
  -- condition
;`;
}

function buildCloneScript(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  const source = getQuotedQualifiedTableName(table, dbType);
  const cloneName = quoteIdentifier(`${table.name}_copy`, dbType);
  return `-- Clone ${getQualifiedTableName(table)}
CREATE TABLE ${cloneName} AS
SELECT *
FROM ${source};`;
}

function buildTruncateScript(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  const qualified = getQuotedQualifiedTableName(table, dbType);
  if (dbType === "sqlite") {
    return `DELETE FROM ${qualified};`;
  }
  return `TRUNCATE TABLE ${qualified};`;
}

function buildDropScript(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  const qualified = getQuotedQualifiedTableName(table, dbType);
  return `DROP TABLE ${qualified};`;
}

// ---------------------------------------------------------------------------
// Filter logic
// ---------------------------------------------------------------------------

/** Apply a single filter condition to a table name or schema name */
function applyCondition(
  value: string,
  condition: FilterCondition
): boolean {
  if (!condition.operator) return true;
  const needle = value.toLowerCase();

  switch (condition.operator) {
    case "equals":
      return needle === condition.value.toLowerCase();
    case "not_equals":
      return needle !== condition.value.toLowerCase();
    case "contains":
      return needle.includes(condition.value.toLowerCase());
    case "not_contains":
      return !needle.includes(condition.value.toLowerCase());
    case "starts_with":
      return needle.startsWith(condition.value.toLowerCase());
    case "ends_with":
      return needle.endsWith(condition.value.toLowerCase());
    case "is_empty":
      return needle === "" || needle === "null";
    case "is_not_empty":
      return needle !== "" && needle !== "null";
    case "like":
      try {
        const escaped = condition.value.replace(/%/g, ".*").replace(/_/g, ".");
        return new RegExp(`^${escaped}$`, "i").test(value);
      } catch {
        return false;
      }
    case "not_like":
      try {
        const escaped = condition.value.replace(/%/g, ".*").replace(/_/g, ".");
        return !new RegExp(`^${escaped}$`, "i").test(value);
      } catch {
        return false;
      }
    case "regex_match":
      try {
        return new RegExp(condition.value, "i").test(value);
      } catch {
        return false;
      }
    case "in_list": {
      const items = condition.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      return items.includes(needle);
    }
    case "not_in_list": {
      const items = condition.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      return !items.includes(needle);
    }
    case "greater_than":
      return needle > condition.value.toLowerCase();
    case "less_than":
      return needle < condition.value.toLowerCase();
    case "greater_or_equal":
      return needle >= condition.value.toLowerCase();
    case "less_or_equal":
      return needle <= condition.value.toLowerCase();
    case "raw_sql":
      // raw_sql is applied separately; skip here
      return true;
    default:
      return true;
  }
}

/** Apply all conditions to a single value using AND/OR logic */
function applyConditions(
  value: string,
  conditions: FilterCondition[],
  logic: "AND" | "OR"
): boolean {
  if (conditions.length === 0) return true;
  const results = conditions.map((c) => applyCondition(value, c));
  return logic === "AND" ? results.every(Boolean) : results.some(Boolean);
}

// ---------------------------------------------------------------------------
// Mixed-state checkbox filter
// ---------------------------------------------------------------------------

export type CheckboxFilterState = "checked" | "unchecked" | "indeterminate";

/** Mixed-state checkbox filter per schema/table group */
export interface MixedStateFilter {
  /** Schema name -> checked items set */
  checkedItems: Record<string, Set<string>>;
  /** Schema name -> unchecked items set */
  uncheckedItems: Record<string, Set<string>>;
  /** Whether the filter is active */
  isActive: boolean;
}

/** Default empty mixed state filter */
export const EMPTY_MIXED_FILTER: MixedStateFilter = {
  checkedItems: {},
  uncheckedItems: {},
  isActive: false,
};

/** Determine filter state for an item */
export function getItemFilterState(
  item: string,
  schema: string,
  filter: MixedStateFilter,
): CheckboxFilterState {
  if (!filter.isActive) return "indeterminate";
  if (filter.uncheckedItems[schema]?.has(item)) return "unchecked";
  if (filter.checkedItems[schema]?.has(item)) return "checked";
  return "indeterminate";
}

/** Check if a table passes the mixed-state filter */
export function passesMixedStateFilter(
  tableName: string,
  schemaName: string,
  filter: MixedStateFilter,
): boolean {
  if (!filter.isActive) return true;
  const isChecked = filter.checkedItems[schemaName]?.has(tableName);
  const isExcluded = filter.uncheckedItems[schemaName]?.has(tableName);
  // If nothing in schema is filtered, pass
  const schemaHasFilter =
    (filter.checkedItems[schemaName]?.size ?? 0) > 0 ||
    (filter.uncheckedItems[schemaName]?.size ?? 0) > 0;
  if (!schemaHasFilter) return true;
  // If checked items exist, only checked items pass (include mode)
  if (isChecked) return true;
  // If excluded, block
  if (isExcluded) return false;
  // Neither checked nor unchecked: indeterminate -> pass
  return true;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSidebar() {
  const { language, t } = useI18n();

  const {
    activeConnectionId,
    connectedIds,
    connections,
    databases,
    currentDatabase,
    tables,
    schemaObjects,
    isLoadingTables,
    isLoadingSchemaObjects,
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
      isLoadingSchemaObjects: state.isLoadingSchemaObjects,
      disconnectFromDatabase: state.disconnectFromDatabase,
      fetchDatabases: state.fetchDatabases,
      fetchTables: state.fetchTables,
      fetchSchemaObjects: state.fetchSchemaObjects,
      switchDatabase: state.switchDatabase,
      addTab: state.addTab,
    }))
  );

  // --- Local state ---
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [activeSchemaFilter, setActiveSchemaFilter] = useState<string>("all");
  const [isSchemaPickerOpen, setIsSchemaPickerOpen] = useState(false);
  const [showCreateWizard, setShowCreateWizard] = useState(false);
  const [tableContextMenu, setTableContextMenu] = useState<{
    table: Pick<TableInfo, "name" | "schema" | "row_count">;
    x: number;
    y: number;
  } | null>(null);
  const [activeContextSubmenuKey, setActiveContextSubmenuKey] = useState<string | null>(null);

  // --- Filter presets state ---
  const [filterPresetMenuOpen, setFilterPresetMenuOpen] = useState(false);
  const [savePresetDialogOpen, setSavePresetDialogOpen] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState("");
  const [operatorSelectorOpen, setOperatorSelectorOpen] = useState(false);
  const [tableOperator, setTableOperator] = useState<FilterOperator>(DEFAULT_FILTER_OPERATOR);
  const [schemaOperator, setSchemaOperator] = useState<FilterOperator>(DEFAULT_FILTER_OPERATOR);
  const [columnModeActive, setColumnModeActive] = useState(false);
  const [columnPattern, setColumnPattern] = useState("");
  const [columnOperator, setColumnOperator] = useState<"name_contains" | "name_equals" | "name_matches_regex">("name_contains");
  const [conditions, setConditions] = useState<FilterCondition[]>([]);
  const [conditionLogic, setConditionLogic] = useState<"AND" | "OR">("AND");

  // --- Mixed-state checkbox filters ---
  const [mixedStateFilter, setMixedStateFilter] = useState<MixedStateFilter>(EMPTY_MIXED_FILTER);
  const mixedFilterRef = useRef<MixedStateFilter>(EMPTY_MIXED_FILTER);

  // Per-table filter persistence
  const tableFilterStateRef = useRef<Record<string, MixedStateFilter>>({});

  const presetsStore = useFilterPresetsStore();
  const { presets, activePresetId } = presetsStore;

  const searchInputRef = useRef<HTMLInputElement>(null);
  const schemaPickerRef = useRef<HTMLDivElement>(null);

  // --- Derived from store ---
  const activeConnection = connections.find((c) => c.id === activeConnectionId);
  const displayCurrentDatabase =
    activeConnection?.db_type === "sqlite"
      ? tables.length > 0
        ? tables[0].schema
          ? tables[0].schema.split("/").pop() || tables[0].schema
          : currentDatabase?.split("/").pop() || currentDatabase
        : ""
      : currentDatabase || "";
  const compactDatabaseName =
    displayCurrentDatabase && displayCurrentDatabase.length > 40
      ? `${displayCurrentDatabase.slice(0, 24)}...${displayCurrentDatabase.slice(-12)}`
      : displayCurrentDatabase;
  const supportsCreateWizard =
    !!activeConnection &&
    ["postgresql", "greenplum", "cockroachdb", "redshift", "mysql", "mariadb", "sqlite"].includes(
      activeConnection.db_type
    );
  const tableWorkspaceKey =
    activeConnectionId && currentDatabase ? `${activeConnectionId}|${currentDatabase}` : "";

  const { pinnedTableSet, pinnedTablesByWorkspace, togglePinnedTable } =
    usePinnedTables(tableWorkspaceKey);

  const dbType = activeConnection?.db_type;

  useEffect(() => {
    if (!activeConnectionId || !currentDatabase) return;
    if (schemaObjects.length > 0 || isLoadingSchemaObjects) return;
    
    const isConnected = useAppStore.getState().connectedIds.has(activeConnectionId);
    if (!isConnected) return;

    const delayMs = search.trim() ? 0 : 900;
    const timer = window.setTimeout(() => {
      void fetchSchemaObjects(activeConnectionId, currentDatabase);
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeConnectionId,
    currentDatabase,
    fetchSchemaObjects,
    isLoadingSchemaObjects,
    schemaObjects.length,
    search,
  ]);

  // --- Actions ---
  const toggleDb = useCallback(
    async (db: DatabaseInfo) => {
      if (!activeConnectionId) return;
      const next = new Set(expandedDbs);
      if (next.has(db.name)) {
        next.delete(db.name);
      } else {
        next.add(db.name);
        await switchDatabase(activeConnectionId, db.name);
      }
      setExpandedDbs(next);
    },
    [activeConnectionId, expandedDbs, switchDatabase],
  );

  const handleTableClick = useCallback(
    (table: Pick<TableInfo, "name" | "schema">) => {
      if (!activeConnectionId) return;
      const qualifiedName = table.schema ? `${table.schema}.${table.name}` : table.name;
      addTab({
        id: `table-${activeConnectionId}-${currentDatabase}-${qualifiedName}`,
        type: "table",
        title: table.name,
        connectionId: activeConnectionId,
        tableName: qualifiedName,
        database: currentDatabase || undefined,
        isPreview: true,
      });
    },
    [activeConnectionId, currentDatabase, addTab],
  );

  const handleTableDoubleClick = useCallback(
    (table: Pick<TableInfo, "name" | "schema">) => {
      if (!activeConnectionId) return;
      const qualifiedName = table.schema ? `${table.schema}.${table.name}` : table.name;
      const tabId = `table-${activeConnectionId}-${currentDatabase}-${qualifiedName}`;
      useAppStore.getState().pinTab(tabId);
    },
    [activeConnectionId, currentDatabase],
  );

  const handleStructureClick = useCallback(
    (e: React.MouseEvent, table: Pick<TableInfo, "name" | "schema">) => {
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
    },
    [activeConnectionId, currentDatabase, addTab],
  );

  const handleObjectSqlClick = useCallback(
    (e: React.MouseEvent, object: SchemaObjectInfo) => {
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
    },
    [activeConnectionId, currentDatabase, addTab],
  );

  const openQueryDraft = useCallback(
    (title: string, content: string) => {
      if (!activeConnectionId) return;
      addTab({
        id: `query-${crypto.randomUUID()}`,
        type: "query",
        title,
        connectionId: activeConnectionId,
        database: currentDatabase || undefined,
        content,
      });
    },
    [activeConnectionId, currentDatabase, addTab],
  );

  const handleOpenTableInNewTab = useCallback(
    (table: Pick<TableInfo, "name" | "schema">) => {
      if (!activeConnectionId) return;
      const qualifiedName = getQualifiedTableName(table);
      addTab({
        id: `table-${activeConnectionId}-${currentDatabase}-${qualifiedName}-${crypto.randomUUID()}`,
        type: "table",
        title: table.name,
        connectionId: activeConnectionId,
        tableName: qualifiedName,
        database: currentDatabase || undefined,
      });
    },
    [activeConnectionId, currentDatabase, addTab],
  );

  const handleOpenStructureDraft = useCallback(
    (table: Pick<TableInfo, "name" | "schema">) => {
      if (!activeConnectionId) return;
      const qualifiedName = getQualifiedTableName(table);
      addTab({
        id: `structure-${activeConnectionId}-${currentDatabase}-${qualifiedName}-${crypto.randomUUID()}`,
        type: "structure",
        title: `${table.name} (structure)`,
        connectionId: activeConnectionId,
        tableName: qualifiedName,
        database: currentDatabase || undefined,
      });
    },
    [activeConnectionId, currentDatabase, addTab],
  );

  const handleCopyTableName = useCallback(async (table: Pick<TableInfo, "name" | "schema">) => {
    await copyToClipboard(getQualifiedTableName(table));
  }, []);

  const handleRefresh = useCallback(async () => {
    if (!activeConnectionId) return;
    await fetchDatabases(activeConnectionId);
    if (currentDatabase) {
      await Promise.all([
        fetchTables(activeConnectionId, currentDatabase),
        fetchSchemaObjects(activeConnectionId, currentDatabase),
      ]);
    }
    EventCenter.emit("workspace-refresh", { connectionId: activeConnectionId, database: currentDatabase || undefined });
  }, [activeConnectionId, currentDatabase, fetchDatabases, fetchTables, fetchSchemaObjects]);

  const handleDisconnect = useCallback(async () => {
    if (!activeConnectionId) return;
    await disconnectFromDatabase(activeConnectionId);
  }, [activeConnectionId, disconnectFromDatabase]);

  // --- Filter preset actions ---
  const handleSavePreset = useCallback(() => {
    const name = presetNameInput.trim();
    if (!name) return;
    presetsStore.savePreset({
      name,
      tableFilter: search,
      schemaFilter: activeSchemaFilter,
      objectTypes: [],
      tags: [],
      columnFilter: columnModeActive
        ? { pattern: columnPattern, operator: columnOperator }
        : undefined,
      conditions,
      conditionLogic,
      columnMode: columnModeActive,
      tableOperator,
      schemaOperator,
    });
    setSavePresetDialogOpen(false);
    setPresetNameInput("");
  }, [
    presetNameInput, search, activeSchemaFilter, columnModeActive,
    columnPattern, columnOperator, conditions, conditionLogic,
    tableOperator, schemaOperator, presetsStore,
  ]);

  const handleLoadPreset = useCallback((presetId: string) => {
    const preset = presetsStore.getPreset(presetId);
    if (!preset) return;
    setSearch(preset.tableFilter);
    setActiveSchemaFilter(preset.schemaFilter);
    setTableOperator(preset.tableOperator ?? DEFAULT_FILTER_OPERATOR);
    setSchemaOperator(preset.schemaOperator ?? DEFAULT_FILTER_OPERATOR);
    setColumnModeActive(preset.columnMode ?? false);
    if (preset.columnFilter) {
      setColumnPattern(preset.columnFilter.pattern);
      setColumnOperator(preset.columnFilter.operator);
    }
    setConditions(preset.conditions ?? []);
    setConditionLogic(preset.conditionLogic ?? "AND");
    presetsStore.setActivePreset(presetId);
    setFilterPresetMenuOpen(false);
  }, [presetsStore]);

  const handleDeletePreset = useCallback((presetId: string) => {
    if (!window.confirm("Delete this filter preset?")) return;
    presetsStore.deletePreset(presetId);
  }, [presetsStore]);

  const handleClearFilters = useCallback(() => {
    setSearch("");
    setActiveSchemaFilter("all");
    setTableOperator(DEFAULT_FILTER_OPERATOR);
    setSchemaOperator(DEFAULT_FILTER_OPERATOR);
    setColumnModeActive(false);
    setColumnPattern("");
    setConditions([]);
    setConditionLogic("AND");
    setMixedStateFilter(EMPTY_MIXED_FILTER);
    mixedFilterRef.current = EMPTY_MIXED_FILTER;
    tableFilterStateRef.current = {};
  }, []);

  // --- Mixed-state filter actions ---
  const handleMixedStateToggle = useCallback((
    schemaName: string,
    itemName: string,
    newState: CheckboxFilterState,
  ) => {
    setMixedStateFilter((prev) => {
      const next: MixedStateFilter = {
        checkedItems: { ...prev.checkedItems },
        uncheckedItems: { ...prev.uncheckedItems },
        isActive: true,
      };
      const schemaChecked = new Set(prev.checkedItems[schemaName] ?? []);
      const schemaUnchecked = new Set(prev.uncheckedItems[schemaName] ?? []);

      if (newState === "indeterminate") {
        schemaChecked.delete(itemName);
        schemaUnchecked.delete(itemName);
      } else if (newState === "checked") {
        schemaChecked.add(itemName);
        schemaUnchecked.delete(itemName);
      } else {
        schemaChecked.delete(itemName);
        schemaUnchecked.add(itemName);
      }

      if (schemaChecked.size > 0) {
        next.checkedItems[schemaName] = schemaChecked;
      }
      if (schemaUnchecked.size > 0) {
        next.uncheckedItems[schemaName] = schemaUnchecked;
      }

      // If nothing is filtered, deactivate
      const hasAnyFilter =
        Object.values(next.checkedItems).some((s) => s.size > 0) ||
        Object.values(next.uncheckedItems).some((s) => s.size > 0);
      next.isActive = hasAnyFilter;

      return next;
    });
    mixedFilterRef.current = {
      ...mixedStateFilter,
      isActive: true,
    };
  }, [mixedStateFilter]);

  const getMixedStateFilterForTable = useCallback((tableName: string, schemaName: string) => {
    const key = `${schemaName}|${tableName}`;
    return tableFilterStateRef.current[key] ?? mixedFilterRef.current;
  }, []);

  const persistMixedStateForTable = useCallback((
    tableName: string,
    schemaName: string,
    filter: MixedStateFilter,
  ) => {
    const key = `${schemaName}|${tableName}`;
    tableFilterStateRef.current[key] = filter;
  }, []);

  const closeTableContextMenu = useCallback(() => {
    setTableContextMenu(null);
    setActiveContextSubmenuKey(null);
  }, []);

  const runMaintenanceCommand = useCallback(async (command: string, tableName: string) => {
    if (!activeConnectionId) return;
    try {
      await invoke("run_maintenance_command", {
        connectionId: activeConnectionId,
        command,
        table: tableName,
        database: currentDatabase || undefined,
      });
      emitAppToast({
        tone: "success",
        title: `${command.toUpperCase()} completed`,
        description: `Maintenance command ${command.toUpperCase()} ran successfully on ${tableName}.`,
      });
      // Refresh workspace after maintenance
      await handleRefresh();
    } catch (err) {
      emitAppToast({
        tone: "error",
        title: `${command.toUpperCase()} failed`,
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [activeConnectionId, currentDatabase, handleRefresh]);

  const handleTableContextMenu = useCallback(
    (
      event: React.MouseEvent,
      table: Pick<TableInfo, "name" | "schema" | "row_count">,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      setTableContextMenu({ table, x: event.clientX, y: event.clientY });
      setActiveContextSubmenuKey(null);
    },
    [],
  );

  // --- Filtering ---
  const filteredTables = useMemo(() => {
    if (!search.trim() && conditions.length === 0 && !columnModeActive) {
      return tables;
    }
    return tables.filter((table) => {
      const qualifiedName = table.schema ? `${table.schema}.${table.name}` : table.name;
      // Apply conditions if any
      if (conditions.length > 0) {
        if (!applyConditions(qualifiedName, conditions, conditionLogic)) return false;
      }
      // Apply search filter if search text exists
      if (search.trim()) {
        if (!applyCondition(qualifiedName, { id: "0", operator: tableOperator, value: search.trim() })) {
          return false;
        }
      }
      return true;
    });
  }, [search, tables, conditions, conditionLogic, tableOperator]);

  const filteredSchemaObjects = useMemo(() => {
    if (!search.trim() && conditions.length === 0) return schemaObjects;
    return schemaObjects.filter((object) => {
      const qualifiedName = object.schema ? `${object.schema}.${object.name}` : object.name;
      const relatedTable = object.related_table || "";
      const typeName = object.object_type.toLowerCase();

      // Apply conditions if any
      if (conditions.length > 0) {
        const combinedValue = `${qualifiedName} ${relatedTable} ${object.object_type}`;
        if (!applyConditions(combinedValue, conditions, conditionLogic)) return false;
      }

      // Apply search filter if search text exists
      if (search.trim()) {
        const filterCond: FilterCondition = { id: "0", operator: tableOperator, value: search.trim() };
        const matchName = applyCondition(qualifiedName, filterCond);
        const matchRelated = relatedTable && applyCondition(relatedTable, filterCond);
        const matchType = applyCondition(typeName, filterCond);
        if (!matchName && !matchRelated && !matchType) return false;
      }
      return true;
    });
  }, [schemaObjects, search, conditions, conditionLogic, tableOperator]);

  const actualTables = useMemo(
    () => filteredTables.filter((table) => table.table_type !== "VIEW"),
    [filteredTables],
  );

  const schemaSections = useSchemaSections(actualTables, filteredSchemaObjects, pinnedTableSet);

  const availableSchemaNames = useMemo(
    () => schemaSections.map((section) => section.schemaName),
    [schemaSections],
  );

  const filteredSchemaSections = useMemo(() => {
    if (activeSchemaFilter === "all") return schemaSections;
    return schemaSections.filter((section) => section.schemaName === activeSchemaFilter);
  }, [activeSchemaFilter, schemaSections]);

  const schemaFilterOptions = useMemo(
    () => [
      {
        value: "all",
        label: t("explorer.allSchemas"),
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
    [schemaSections, t],
  );

  const { summaryLabel, visibleTableCount, visibleObjectCount } = useExplorerSummary(filteredSchemaSections, language);
  const hasSearch = search.trim().length > 0;

  // --- SQL keyword autocomplete suggestions ---
  const autocompleteItems = useMemo<string[]>(() => {
    const keywords = [
      // Clauses
      "WHERE", "AND", "OR", "NOT", "IN", "NOT IN", "BETWEEN", "LIKE", "ILIKE",
      "ORDER BY", "GROUP BY", "HAVING", "LIMIT", "OFFSET",
      "SELECT", "FROM", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL OUTER JOIN",
      "CROSS JOIN", "ON", "USING",
      "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM",
      "CREATE TABLE", "ALTER TABLE", "DROP TABLE", "TRUNCATE",
      "CREATE INDEX", "DROP INDEX",
      "DISTINCT", "ALL", "AS", "CASE", "WHEN", "THEN", "ELSE", "END",
      "UNION", "UNION ALL", "EXCEPT", "INTERSECT",
      "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "NULLIF",
      "NOW()", "CURRENT_DATE", "CURRENT_TIMESTAMP",
      "TRUE", "FALSE", "NULL",
      // Aggregate with ALL
      "COUNT(*)", "COUNT(DISTINCT", "SUM(", "AVG(", "MAX(", "MIN(",
      // Window-like
      "OVER", "PARTITION BY", "ROW_NUMBER()", "RANK()", "DENSE_RANK()",
      "LEAD(", "LAG(", "FIRST_VALUE(", "LAST_VALUE(",
    ];
    if (!search.trim()) return [];
    const needle = search.toLowerCase();
    return keywords.filter((kw) => kw.toLowerCase().includes(needle)).slice(0, 12);
  }, [search]);

  // --- Context menu ---
  const tableContextMenuItems = useMemo<ExplorerContextMenuItem[]>(() => {
    if (!tableContextMenu) return [];

    const table = tableContextMenu.table;
    const qualifiedName = getQualifiedTableName(table);
    const isPinned = pinnedTableSet.has(qualifiedName);

    return [
      {
        key: "open-in-new-tab",
        label: t("explorer.context.openInNewTab"),
        action: () => handleOpenTableInNewTab(table),
      },
      {
        key: "open-structure",
        label: t("explorer.context.openStructure"),
        action: () => handleOpenStructureDraft(table),
      },
      {
        key: "item-overview",
        label: t("explorer.context.itemOverview"),
        action: () => openQueryDraft(`${table.name} overview`, buildOverviewScript(table, dbType)),
      },
      { key: "divider-primary", divider: true },
      {
        key: "copy-name",
        label: t("explorer.context.copyName"),
        action: () => void handleCopyTableName(table),
      },
      {
        key: "pin-to-top",
        label: isPinned ? t("explorer.context.unpin") : t("explorer.context.pinToTop"),
        action: () => togglePinnedTable(table),
      },
      {
        key: "export",
        label: t("explorer.context.export"),
        children: [
          {
            key: "export-select",
            label: t("explorer.context.exportSelect"),
            action: () => openQueryDraft(`${table.name} export`, buildSelectScript(table, dbType)),
          },
          {
            key: "export-copy",
            label: t("explorer.context.copySelect"),
            action: () => void copyToClipboard(buildSelectScript(table, dbType)),
          },
        ],
      },
      {
        key: "import",
        label: t("explorer.context.import"),
        children: [
          {
            key: "import-insert",
            label: t("explorer.context.importInsert"),
            action: () => openQueryDraft(`${table.name} insert`, buildInsertTemplate(table, dbType)),
          },
          {
            key: "import-guide",
            label: t("explorer.context.importGuide"),
            action: () =>
              openQueryDraft(
                `${table.name} import`,
                `-- Import guide for ${qualifiedName}\n-- Paste your INSERT statements or load a .sql file here.\n\n${buildInsertTemplate(table, dbType)}`
              ),
          },
        ],
      },
      {
        key: "new",
        label: t("explorer.context.new"),
        children: [
          {
            key: "new-query",
            label: t("explorer.context.newQuery"),
            action: () => openQueryDraft(`${table.name} query`, buildSelectScript(table, dbType)),
          },
          {
            key: "new-structure",
            label: t("explorer.context.newStructure"),
            action: () => handleOpenStructureDraft(table),
          },
        ],
      },
      {
        key: "copy-script-as",
        label: t("explorer.context.copyScriptAs"),
        children: [
          {
            key: "copy-select",
            label: t("explorer.context.copySelect"),
            action: () => void copyToClipboard(buildSelectScript(table, dbType)),
          },
          {
            key: "copy-insert",
            label: t("explorer.context.copyInsert"),
            action: () => void copyToClipboard(buildInsertTemplate(table, dbType)),
          },
          {
            key: "copy-update",
            label: t("explorer.context.copyUpdate"),
            action: () => void copyToClipboard(buildUpdateTemplate(table, dbType)),
          },
          {
            key: "copy-delete",
            label: t("explorer.context.copyDelete"),
            action: () => void copyToClipboard(buildDeleteTemplate(table, dbType)),
          },
        ],
      },
      { key: "divider-maintenance", divider: true },
      {
        key: "maintenance",
        label: "Maintenance",
        children: [
          // VACUUM: PostgreSQL, SQLite
          ...(["postgresql", "greenplum", "cockroachdb", "redshift", "vertica", "sqlite", "libsql", "cloudflare_d1"].includes(dbType || "")
            ? [{
                key: "maintenance-vacuum",
                label: "VACUUM",
                action: () => void runMaintenanceCommand("vacuum", table.name),
              }]
            : []),
          // ANALYZE: PostgreSQL, MySQL, SQLite
          ...(["postgresql", "greenplum", "cockroachdb", "redshift", "vertica", "mysql", "mariadb", "sqlite", "libsql", "cloudflare_d1"].includes(dbType || "")
            ? [{
                key: "maintenance-analyze",
                label: "ANALYZE",
                action: () => void runMaintenanceCommand("analyze", table.name),
              }]
            : []),
          // OPTIMIZE TABLE: MySQL, ClickHouse
          ...(["mysql", "mariadb", "clickhouse"].includes(dbType || "")
            ? [{
                key: "maintenance-optimize",
                label: "OPTIMIZE TABLE",
                action: () => void runMaintenanceCommand("optimize", table.name),
              }]
            : []),
          // REINDEX: PostgreSQL, SQLite
          ...(["postgresql", "greenplum", "cockroachdb", "redshift", "vertica", "sqlite", "libsql", "cloudflare_d1"].includes(dbType || "")
            ? [{
                key: "maintenance-reindex",
                label: "REINDEX",
                action: () => void runMaintenanceCommand("reindex", table.name),
              }]
            : []),
          // CHECK TABLE: MySQL, PostgreSQL
          ...(["mysql", "mariadb", "postgresql", "greenplum", "cockroachdb"].includes(dbType || "")
            ? [{
                key: "maintenance-check",
                label: "CHECK TABLE",
                action: () => void runMaintenanceCommand("check_table", table.name),
              }]
            : []),
        ],
      },
      { key: "divider-danger", divider: true },
      {
        key: "clone",
        label: t("explorer.context.clone"),
        action: () => openQueryDraft(`${table.name} clone`, buildCloneScript(table, dbType)),
      },
      {
        key: "truncate",
        label: t("explorer.context.truncate"),
        action: () => openQueryDraft(`${table.name} truncate`, buildTruncateScript(table, dbType)),
        danger: true,
      },
      {
        key: "delete",
        label: t("explorer.context.delete"),
        action: () => openQueryDraft(`${table.name} delete`, buildDropScript(table, dbType)),
        danger: true,
      },
    ];
  }, [dbType, pinnedTableSet, t, tableContextMenu, handleOpenTableInNewTab, handleOpenStructureDraft, handleCopyTableName, openQueryDraft, togglePinnedTable, activeConnectionId, currentDatabase]);

  // --- Effects ---
  useEffect(() => {
    if (schemaSections.length === 0) {
      setActiveSchemaFilter("all");
      return;
    }

    const hasPublic = availableSchemaNames.includes("public");
    setActiveSchemaFilter((prev) => {
      if (prev !== "all" && availableSchemaNames.includes(prev)) {
        return prev;
      }
      if (hasPublic) return "public";
      return schemaSections[0]?.schemaName || "all";
    });
  }, [availableSchemaNames, schemaSections]);

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

  // EventCenter: respond to explorer-search-focus event
  useEvent("explorer-search-focus", () => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  });

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

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      EXPLORER_PINNED_TABLES_STORAGE_KEY,
      JSON.stringify(pinnedTablesByWorkspace)
    );
  }, [pinnedTablesByWorkspace]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeTableContextMenu();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [closeTableContextMenu]);

  useEffect(() => {
    closeTableContextMenu();
  }, [currentDatabase, activeConnectionId, search, closeTableContextMenu]);

  // --- Return ---
  return {
    // Store data
    activeConnectionId,
    connectedIds,
    connections,
    databases,
    currentDatabase,
    tables,
    schemaObjects,
    isLoadingTables,
    // Local state
    expandedDbs,
    search,
    setSearch,
    activeSchemaFilter,
    setActiveSchemaFilter,
    isSchemaPickerOpen,
    setIsSchemaPickerOpen,
    showCreateWizard,
    setShowCreateWizard,
    tableContextMenu,
    activeContextSubmenuKey,
    setActiveContextSubmenuKey,
    searchInputRef,
    schemaPickerRef,
    // Filter presets
    filterPresetMenuOpen,
    setFilterPresetMenuOpen,
    savePresetDialogOpen,
    setSavePresetDialogOpen,
    presetNameInput,
    setPresetNameInput,
    operatorSelectorOpen,
    setOperatorSelectorOpen,
    tableOperator,
    setTableOperator,
    schemaOperator,
    setSchemaOperator,
    columnModeActive,
    setColumnModeActive,
    columnPattern,
    setColumnPattern,
    columnOperator,
    setColumnOperator,
    conditions,
    setConditions,
    conditionLogic,
    setConditionLogic,
    mixedStateFilter,
    handleMixedStateToggle,
    getMixedStateFilterForTable,
    persistMixedStateForTable,
    presets,
    activePresetId,
    handleSavePreset,
    handleLoadPreset,
    handleDeletePreset,
    handleClearFilters,
    // Derived
    activeConnection,
    compactDatabaseName,
    supportsCreateWizard,
    dbType,
    filteredSchemaSections,
    availableSchemaNames,
    schemaFilterOptions,
    summaryLabel,
    hasSearch,
    visibleTableCount,
    visibleObjectCount,
    language,
    t,
    pinnedTableSet,
    // SQL keyword suggestions for autocomplete
    autocompleteItems,
    // Actions
    toggleDb,
    handleTableClick,
    handleTableDoubleClick,
    handleStructureClick,
    handleObjectSqlClick,
    handleTableContextMenu,
    handleRefresh,
    handleDisconnect,
    closeTableContextMenu,
    openQueryDraft,
    addTab,
    tableContextMenuItems,
  };
}
