import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";

import { useConnectionStore } from "../../../stores/connectionStore";
import { useUIStore } from "../../../stores/uiStore";
import { useI18n } from "../../../i18n";
import { useEvent, EventCenter } from "../../../stores/event-center";
import { getQualifiedTableName, normalizeObjectSql, copyToClipboard } from "../SidebarUtils";
import { getBulkActionsCopy } from "../bulk-actions-copy";
import { getCodegenCopy } from "../codegen-copy";
import { generateCode, type CodegenTarget } from "../../../utils/schema-codegen";
import type { BulkDropTablePreview } from "../components/BulkDropTablesModal";
import { applyConditionsWith, applyCondition, buildDropScript } from "./sidebar-filter-scripts";
import { getSidebarAutocompleteItems } from "./sidebar-autocomplete";
import { buildTableContextMenuItems } from "./sidebar-context-menu";
import { emitAppToast } from "../../../utils/app-toast";
import { saveDatabaseDocs } from "../../../utils/schema-doc-collector";
import { useQueryStore } from "../../../stores/queryStore";
import {
  usePinnedTables,
  useSchemaSections,
  useExplorerSummary,
  explorerSectionObjectCount,
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
import { useDbVisibilityStore, filterVisibleDatabases } from "../../../stores/dbVisibilityStore";
import {
  DEFAULT_EXPORT_FORMATS,
  getCompiledExportFormats,
  type ExportFormatInfo,
  type TableExportFormat,
} from "../../../utils/export-formats";
import { useRoutineEditorStore } from "../../RoutineEditor/routineEditorStore";
import { useTableFilterActions } from "./useTableFilterActions";
import { requestAppConfirmation, requestAppExportEncryption } from "../../../stores/confirmStore";

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
  } = useConnectionStore(
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
    })),
  );
  const addTab = useUIStore((state) => state.addTab);

  // --- Local state ---
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [activeSchemaFilter, setActiveSchemaFilter] = useState<string>("all");
  const [isSchemaPickerOpen, setIsSchemaPickerOpen] = useState(false);
  const [showCreateWizard, setShowCreateWizard] = useState(false);
  const [tableContextMenu, setTableContextMenu] = useState<{
    table: Pick<TableInfo, "name" | "schema" | "row_count" | "table_type">;
    /** Present when the context menu targets a multi-selection. */
    tables?: Pick<TableInfo, "name" | "schema" | "row_count" | "table_type">[];
    x: number;
    y: number;
  } | null>(null);
  // --- Multi-select state (Ctrl/Shift-click on table rows) ---
  const [selectedTableKeys, setSelectedTableKeys] = useState<Set<string>>(new Set());
  const selectionAnchorRef = useRef<string | null>(null);
  const [isBulkExporting, setIsBulkExporting] = useState(false);
  const [bulkDrop, setBulkDrop] = useState<{
    tables: (BulkDropTablePreview & { table: Pick<TableInfo, "name" | "schema"> })[];
    isLoadingCounts: boolean;
    isDropping: boolean;
  } | null>(null);
  const [seedRowsTarget, setSeedRowsTarget] = useState<Pick<TableInfo, "name" | "schema"> | null>(
    null,
  );
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
  const [columnOperator, setColumnOperator] = useState<
    "name_contains" | "name_equals" | "name_matches_regex"
  >("name_contains");
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
      activeConnection.db_type,
    );
  const tableWorkspaceKey =
    activeConnectionId && currentDatabase ? `${activeConnectionId}|${currentDatabase}` : "";

  const { pinnedTableSet, pinnedTablesByWorkspace, togglePinnedTable } =
    usePinnedTables(tableWorkspaceKey);

  const dbType = activeConnection?.db_type;
  const hiddenDatabases = useDbVisibilityStore((state) => state.hiddenDatabases);
  const visibleDatabases = useMemo(
    () => filterVisibleDatabases(activeConnectionId, databases, currentDatabase, hiddenDatabases),
    [activeConnectionId, databases, currentDatabase, hiddenDatabases],
  );

  useEffect(() => {
    if (!activeConnectionId || !currentDatabase) return;
    if (schemaObjects.length > 0 || isLoadingSchemaObjects) return;

    const isConnected = useConnectionStore.getState().connectedIds.has(activeConnectionId);
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

  const handleTableDoubleClick = useCallback(
    (table: Pick<TableInfo, "name" | "schema">) => {
      if (!activeConnectionId) return;
      const qualifiedName = table.schema ? `${table.schema}.${table.name}` : table.name;
      const tabId = `table-${activeConnectionId}-${currentDatabase}-${qualifiedName}`;
      useUIStore.getState().pinTab(tabId);
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
      const tabKind = (object.object_type ?? "").toLowerCase();
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

  const handleRoutineClick = useCallback(
    (object: SchemaObjectInfo) => {
      if (!activeConnectionId) return;
      useRoutineEditorStore.getState().open(activeConnectionId, {
        name: object.name,
        schema: object.schema,
      });
    },
    [activeConnectionId],
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

  const handleGenerateTestRows = useCallback(
    (table: Pick<TableInfo, "name" | "schema">) => setSeedRowsTarget(table),
    [],
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

  const codegenCopy = useMemo(() => getCodegenCopy(language), [language]);

  /** Generate a Markdown schema book for this table through the save dialog. */
  const [queryBuilderTable, setQueryBuilderTable] = useState<string | null>(null);
  const queryStore = useQueryStore.getState();
  const handleOpenQueryBuilder = useCallback(
    async (tableName: string) => {
      try {
        await queryStore.getTableColumnsPreview(
          activeConnectionId ?? "",
          tableName,
          currentDatabase || undefined,
        );
      } catch {
        // Column loading is best-effort; the panel shows an empty list.
      }
      setQueryBuilderTable(tableName);
    },
    [activeConnectionId, currentDatabase, queryStore],
  );

  const handleGenerateTableDocs = useCallback(
    async (table: Pick<TableInfo, "name" | "schema">) => {
      if (!activeConnectionId) return;
      try {
        const saved = await saveDatabaseDocs(
          activeConnectionId,
          currentDatabase || table.name,
          "markdown",
          [table.name],
        );
        if (saved !== null) {
          emitAppToast({
            title: t("explorer.context.docsSaved"),
            description: saved,
            tone: "success",
          });
        }
      } catch (error) {
        emitAppToast({
          title: t("explorer.context.docsFailed"),
          description: error instanceof Error ? error.message : String(error),
          tone: "error",
        });
      }
    },
    [activeConnectionId, currentDatabase, t],
  );

  /** Copy the table's columns as a generated type/schema in the target language. */
  const handleCopyAsCode = useCallback(
    async (table: Pick<TableInfo, "name" | "schema">, target: CodegenTarget) => {
      if (!activeConnectionId) return;
      try {
        const structure = await queryStore.getTableStructure(
          activeConnectionId,
          table.name,
          currentDatabase || undefined,
        );
        const result = generateCode(structure.columns, table.name, target);
        await copyToClipboard(result.code);
        emitAppToast({
          title: codegenCopy.copiedTitle(result.typeName, result.fieldCount),
          tone: "success",
        });
      } catch (error) {
        emitAppToast({
          title: codegenCopy.failedTitle,
          description: error instanceof Error ? error.message : String(error),
          tone: "error",
        });
      }
    },
    [activeConnectionId, currentDatabase, codegenCopy, queryStore],
  );
  const handleRefresh = useCallback(async () => {
    if (!activeConnectionId) return;
    await fetchDatabases(activeConnectionId);
    if (currentDatabase) {
      await Promise.all([
        fetchTables(activeConnectionId, currentDatabase),
        fetchSchemaObjects(activeConnectionId, currentDatabase),
      ]);
    }
    EventCenter.emit("workspace-refresh", {
      connectionId: activeConnectionId,
      database: currentDatabase || undefined,
    });
  }, [activeConnectionId, currentDatabase, fetchDatabases, fetchTables, fetchSchemaObjects]);

  const handleDisconnect = useCallback(async () => {
    if (!activeConnectionId) return;
    const connectionName =
      useConnectionStore.getState().connections.find((c) => c.id === activeConnectionId)?.name ??
      activeConnectionId;
    const approved = await requestAppConfirmation({
      title: t("confirm.disconnectTitle"),
      message: t("confirm.disconnectMessage", { name: connectionName }),
      confirmText: t("explorer.disconnect"),
    });
    if (!approved) return;
    await disconnectFromDatabase(activeConnectionId);
  }, [activeConnectionId, disconnectFromDatabase, t]);

  // --- Filter preset actions ---

  // --- Mixed-state filter actions ---

  const {
    handleSavePreset,
    handleLoadPreset,
    handleDeletePreset,
    handleClearFilters,
    handleMixedStateToggle,
    getMixedStateFilterForTable,
    persistMixedStateForTable,
  } = useTableFilterActions({
    presetNameInput,
    search,
    activeSchemaFilter,
    columnModeActive,
    columnPattern,
    columnOperator,
    conditions,
    conditionLogic,
    tableOperator,
    schemaOperator,
    presetsStore,
    setSearch,
    setActiveSchemaFilter,
    setTableOperator,
    setSchemaOperator,
    setColumnModeActive,
    setColumnPattern,
    setColumnOperator,
    setConditions,
    setConditionLogic,
    setSavePresetDialogOpen,
    setPresetNameInput,
    setFilterPresetMenuOpen,
    mixedStateFilter,
    setMixedStateFilter,
    mixedFilterRef,
    tableFilterStateRef,
  });

  const closeTableContextMenu = useCallback(() => {
    setTableContextMenu(null);
    setActiveContextSubmenuKey(null);
  }, []);

  const runMaintenanceCommand = useCallback(
    async (command: string, tableName: string) => {
      if (!activeConnectionId) return;
      try {
        const preview = await invoke<{ sql: string; requiresConfirmation: boolean }>(
          "preview_maintenance_command",
          {
            connectionId: activeConnectionId,
            command,
            table: tableName,
            database: currentDatabase || undefined,
          },
        );
        const approved = await requestAppConfirmation({
          title: t("confirm.maintenanceTitle"),
          message: t("confirm.maintenanceMessage", { sql: preview.sql, table: tableName }),
          confirmText: t("common.confirm"),
        });
        if (!approved) return;
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
    },
    [activeConnectionId, currentDatabase, handleRefresh, t],
  );

  // --- Filtering ---
  const filteredTables = useMemo(() => {
    if (!search.trim() && conditions.length === 0 && !columnModeActive) {
      return tables;
    }
    return tables.filter((table) => {
      const qualifiedName = table.schema ? `${table.schema}.${table.name}` : table.name;
      // Apply conditions if any — each condition targets the field chosen in
      // the Property column of the filter settings modal (Name / Schema).
      if (conditions.length > 0) {
        if (
          !applyConditionsWith(
            (cond) =>
              cond.column === "schema"
                ? (table.schema ?? "")
                : cond.column === "type"
                  ? (table.table_type ?? "")
                  : cond.column === "create_date"
                    ? (table.create_date ?? "")
                    : qualifiedName,
            conditions,
            conditionLogic,
          )
        ) {
          return false;
        }
      }
      // Apply search filter if search text exists
      if (search.trim()) {
        if (
          !applyCondition(qualifiedName, { id: "0", operator: tableOperator, value: search.trim() })
        ) {
          return false;
        }
      }
      return true;
    });
  }, [search, conditions, columnModeActive, tables, conditionLogic, tableOperator]);

  const filteredSchemaObjects = useMemo(() => {
    if (!search.trim() && conditions.length === 0) return schemaObjects;
    return schemaObjects.filter((object) => {
      const qualifiedName = object.schema ? `${object.schema}.${object.name}` : object.name;
      const relatedTable = object.related_table || "";
      // Some schema objects (e.g. system folders) may lack object_type.
      const typeName = (object.object_type ?? "").toLowerCase();

      // Apply conditions if any — each condition targets the field chosen in
      // the Property column of the filter settings modal (Name / Schema).
      if (conditions.length > 0) {
        if (
          !applyConditionsWith(
            (cond) =>
              cond.column === "schema"
                ? (object.schema ?? "")
                : cond.column === "type"
                  ? typeName
                  : cond.column === "create_date"
                    ? (object.create_date ?? "")
                    : qualifiedName,
            conditions,
            conditionLogic,
          )
        ) {
          return false;
        }
      }

      // Apply search filter if search text exists
      if (search.trim()) {
        const filterCond: FilterCondition = {
          id: "0",
          operator: tableOperator,
          value: search.trim(),
        };
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

  // SSMS parity: on SQL Server fold `sys`/`INFORMATION_SCHEMA` objects into the
  // `dbo` section so "System …" folders render like SSMS's database node.
  const schemaSections = useSchemaSections(
    actualTables,
    filteredSchemaObjects,
    pinnedTableSet,
    dbType === "mssql",
  );

  const availableSchemaNames = useMemo(
    () => schemaSections.map((section) => section.schemaName),
    [schemaSections],
  );

  const filteredSchemaSections = useMemo(() => {
    if (activeSchemaFilter === "all") return schemaSections;
    return schemaSections.filter((section) => section.schemaName === activeSchemaFilter);
  }, [activeSchemaFilter, schemaSections]);

  // --- Multi-select ---
  // Visible table order (section order, then in-section order) drives
  // Shift-click range selection.
  const orderedVisibleTables = useMemo(
    () => filteredSchemaSections.flatMap((section) => section.tables),
    [filteredSchemaSections],
  );
  const selectedTables = useMemo(
    () =>
      orderedVisibleTables.filter((table) => selectedTableKeys.has(getQualifiedTableName(table))),
    [orderedVisibleTables, selectedTableKeys],
  );
  const bulkCopy = useMemo(() => getBulkActionsCopy(language), [language]);

  const clearTableSelection = useCallback(() => {
    setSelectedTableKeys(new Set());
    selectionAnchorRef.current = null;
  }, []);

  const handleTableClick = useCallback(
    (
      event: React.MouseEvent | undefined,
      table: Pick<TableInfo, "name" | "schema"> & { table_type?: string },
    ) => {
      const isSelectableTable = table.table_type !== "VIEW";
      const key = getQualifiedTableName(table);

      // Ctrl/Cmd-click toggles membership without opening a preview tab.
      if (isSelectableTable && (event?.ctrlKey || event?.metaKey)) {
        setSelectedTableKeys((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        selectionAnchorRef.current = key;
        return;
      }

      // Shift-click selects the visible range from the anchor to this row.
      if (isSelectableTable && event?.shiftKey && selectionAnchorRef.current) {
        const orderedKeys = orderedVisibleTables.map((t) => getQualifiedTableName(t));
        const anchorIndex = orderedKeys.indexOf(selectionAnchorRef.current);
        const targetIndex = orderedKeys.indexOf(key);
        if (anchorIndex !== -1 && targetIndex !== -1) {
          const [from, to] =
            anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
          setSelectedTableKeys(new Set(orderedKeys.slice(from, to + 1)));
          return;
        }
      }

      // Plain click: open the preview tab and collapse any multi-selection.
      if (selectedTableKeys.size > 0) setSelectedTableKeys(new Set());
      selectionAnchorRef.current = key;
      if (!activeConnectionId) return;
      const qualifiedName = table.schema ? `${table.schema}.${table.name}` : table.name;
      addTab({
        id: `table-${activeConnectionId}-${currentDatabase}-${qualifiedName}`,
        type: "table",
        title: table.name,
        connectionId: activeConnectionId,
        tableName: qualifiedName,
        database: currentDatabase ?? undefined,
        isPreview: true,
      });
    },
    [activeConnectionId, currentDatabase, addTab, orderedVisibleTables, selectedTableKeys.size],
  );

  const handleBulkExport = useCallback(
    async (format: TableExportFormat) => {
      if (!activeConnectionId || selectedTables.length === 0 || isBulkExporting) return;
      const encrypt = await requestAppExportEncryption({
        fileLabel: `${selectedTables.length} × .${format}`,
      });
      if (!encrypt.confirmed) return;
      const directory = await openDirectoryDialog({ directory: true, multiple: false });
      if (typeof directory !== "string" || !directory) return;
      setIsBulkExporting(true);
      try {
        const result = await invoke<{
          exported: { filePath: string; rowCount: number }[];
          failed: { table: string; error: string }[];
          cancelled: boolean;
        }>("export_tables_to_directory", {
          connectionId: activeConnectionId,
          operationId: `bulk-export-${crypto.randomUUID()}`,
          request: {
            tables: selectedTables.map((table) => getQualifiedTableName(table)),
            database: currentDatabase || null,
            format,
            directory,
            encryptPassword: encrypt.password,
          },
        });
        if (result.cancelled) {
          emitAppToast({ tone: "info", title: bulkCopy.exportCancelled });
        } else if (result.failed.length > 0) {
          emitAppToast({
            tone: "error",
            title: bulkCopy.exportDone(result.exported.length, result.failed.length),
            description: result.failed
              .map((failure) => `${failure.table}: ${failure.error}`)
              .join("\n"),
          });
        } else {
          emitAppToast({
            tone: "success",
            title: bulkCopy.exportDone(result.exported.length, 0),
            description: directory,
          });
        }
      } catch (error) {
        emitAppToast({
          tone: "error",
          title: bulkCopy.exportFailed,
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setIsBulkExporting(false);
      }
    },
    [activeConnectionId, selectedTables, isBulkExporting, currentDatabase, bulkCopy],
  );

  const openBulkDrop = useCallback(async () => {
    if (!activeConnectionId || selectedTables.length === 0 || bulkDrop) return;
    const targets = selectedTables.map((table) => ({
      qualifiedName: getQualifiedTableName(table),
      rowCount: null as number | null | undefined,
      table,
    }));
    setBulkDrop({ tables: targets, isLoadingCounts: true, isDropping: false });
    // Read-only COUNT(*) previews; failures surface as "unknown" rows.
    const counts = await Promise.all(
      targets.map(async (target) => {
        try {
          return await useQueryStore
            .getState()
            .countRows(activeConnectionId, target.qualifiedName, currentDatabase || undefined);
        } catch {
          return undefined;
        }
      }),
    );
    setBulkDrop((prev) =>
      prev
        ? {
            ...prev,
            isLoadingCounts: false,
            tables: prev.tables.map((entry, index) => ({
              ...entry,
              rowCount: counts[index],
            })),
          }
        : prev,
    );
  }, [activeConnectionId, selectedTables, bulkDrop, currentDatabase]);

  const confirmBulkDrop = useCallback(async () => {
    if (!activeConnectionId || !bulkDrop || bulkDrop.isDropping) return;
    setBulkDrop((prev) => (prev ? { ...prev, isDropping: true } : prev));
    try {
      // DROP goes through execute_structure_statements, which asserts Safe
      // Mode on the backend before touching the driver.
      const statements = bulkDrop.tables.map((entry) =>
        buildDropScript(entry.table, dbType).replace(/;+\s*$/, ""),
      );
      await useQueryStore.getState().executeStructureStatements(activeConnectionId, statements);
      emitAppToast({ tone: "success", title: bulkCopy.dropDone(bulkDrop.tables.length) });
      setBulkDrop(null);
      clearTableSelection();
      await handleRefresh();
    } catch (error) {
      emitAppToast({
        tone: "error",
        title: bulkCopy.dropFailed,
        description: error instanceof Error ? error.message : String(error),
      });
      setBulkDrop((prev) => (prev ? { ...prev, isDropping: false } : prev));
    }
  }, [activeConnectionId, bulkDrop, bulkCopy, clearTableSelection, dbType, handleRefresh]);

  const closeBulkDrop = useCallback(() => {
    setBulkDrop((prev) => (prev?.isDropping ? prev : null));
  }, []);
  const handleTableContextMenu = useCallback(
    (
      event: React.MouseEvent,
      table: Pick<TableInfo, "name" | "schema" | "row_count" | "table_type">,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const key = getQualifiedTableName(table);
      // Right-clicking inside a multi-selection targets the whole selection;
      // right-clicking outside it collapses the selection (Explorer parity).
      const targets =
        selectedTableKeys.size > 1 && selectedTableKeys.has(key)
          ? orderedVisibleTables.filter((t) => selectedTableKeys.has(getQualifiedTableName(t)))
          : undefined;
      if (!targets && selectedTableKeys.size > 0) {
        setSelectedTableKeys(new Set());
        selectionAnchorRef.current = key;
      }
      setTableContextMenu({ table, tables: targets, x: event.clientX, y: event.clientY });
      setActiveContextSubmenuKey(null);
    },
    [orderedVisibleTables, selectedTableKeys],
  );

  const schemaFilterOptions = useMemo(
    () => [
      {
        value: "all",
        label: t("explorer.allSchemas"),
        count: schemaSections.reduce(
          (total, section) => total + section.tables.length + explorerSectionObjectCount(section),
          0,
        ),
      },
      ...schemaSections.map((section) => ({
        value: section.schemaName,
        label: section.schemaName,
        count: section.tables.length + explorerSectionObjectCount(section),
      })),
    ],
    [schemaSections, t],
  );

  const { summaryLabel, visibleTableCount, visibleObjectCount } = useExplorerSummary(
    filteredSchemaSections,
    language,
  );
  const hasSearch = search.trim().length > 0;

  // --- SQL keyword autocomplete suggestions ---
  const autocompleteItems = useMemo<string[]>(() => getSidebarAutocompleteItems(search), [search]);

  // Export formats compiled into the backend (`parquet` is absent when the
  // cargo feature is off); fetched once — the set cannot change at runtime.
  const [exportFormats, setExportFormats] = useState<ExportFormatInfo[]>(DEFAULT_EXPORT_FORMATS);
  useEffect(() => {
    let cancelled = false;
    void getCompiledExportFormats().then((formats) => {
      if (!cancelled) setExportFormats(formats);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // --- Context menu ---
  const tableContextMenuItems = useMemo<ExplorerContextMenuItem[]>(
    () =>
      buildTableContextMenuItems({
        tableContextMenu,
        pinnedTableSet,
        dbType,
        language,
        t,
        bulkCopy,
        codegenCopy,
        onOpenTableInNewTab: handleOpenTableInNewTab,
        onOpenStructureDraft: handleOpenStructureDraft,
        openQueryDraft,
        onCopyTableName: handleCopyTableName,
        onCopyAsCode: handleCopyAsCode,
        onGenerateTableDocs: handleGenerateTableDocs,
        exportFormats,
        onOpenQueryBuilder: handleOpenQueryBuilder,
        onGenerateTestRows: handleGenerateTestRows,
        onTogglePinnedTable: togglePinnedTable,
        onRunMaintenanceCommand: runMaintenanceCommand,
        onBulkExport: handleBulkExport,
        onOpenBulkDrop: openBulkDrop,
      }),
    [
      tableContextMenu,
      pinnedTableSet,
      dbType,
      language,
      t,
      bulkCopy,
      codegenCopy,
      handleOpenTableInNewTab,
      handleOpenStructureDraft,
      openQueryDraft,
      handleCopyTableName,
      handleCopyAsCode,
      exportFormats,
      handleGenerateTableDocs,
      handleOpenQueryBuilder,
      handleGenerateTestRows,
      togglePinnedTable,
      runMaintenanceCommand,
      handleBulkExport,
      openBulkDrop,
    ],
  );

  // Selection is scoped to the current connection + database workspace.
  useEffect(() => {
    setSelectedTableKeys(new Set());
    selectionAnchorRef.current = null;
    setBulkDrop(null);
  }, [currentDatabase, activeConnectionId]);

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
      JSON.stringify(pinnedTablesByWorkspace),
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
    databases: visibleDatabases,
    currentDatabase,
    tables,
    schemaObjects,
    isLoadingTables,
    // Query builder
    queryBuilderTable,
    setQueryBuilderTable,
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
    selectedTableKeys,
    selectedTables,
    bulkCopy,
    isBulkExporting,
    bulkDrop,
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
    handleRoutineClick,
    handleTableContextMenu,
    handleRefresh,
    handleDisconnect,
    closeTableContextMenu,
    openQueryDraft,
    seedRowsTarget,
    setSeedRowsTarget,
    handleGenerateTestRows,
    addTab,
    tableContextMenuItems,
    clearTableSelection,
    handleBulkExport,
    openBulkDrop,
    confirmBulkDrop,
    closeBulkDrop,
  };
}
