import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useAppStore } from "../../../stores/appStore";
import { useI18n } from "../../../i18n";
import {
  getQualifiedTableName,
  getQuotedQualifiedTableName,
  quoteIdentifier,
  normalizeObjectSql,
  copyToClipboard,
} from "../SidebarUtils";
import {
  usePinnedTables,
  useSchemaSections,
  useExplorerSummary,
} from "./useTreeState";
import { EXPLORER_PINNED_TABLES_STORAGE_KEY } from "./useTreeState";
import type { DatabaseInfo, SchemaObjectInfo, TableInfo } from "../../../types";
import type { ExplorerContextMenuItem } from "../components/ContextMenu";

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
      });
    },
    [activeConnectionId, currentDatabase, addTab],
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
  }, [activeConnectionId, currentDatabase, fetchDatabases, fetchTables, fetchSchemaObjects]);

  const handleDisconnect = useCallback(async () => {
    if (!activeConnectionId) return;
    await disconnectFromDatabase(activeConnectionId);
  }, [activeConnectionId, disconnectFromDatabase]);

  const closeTableContextMenu = useCallback(() => {
    setTableContextMenu(null);
    setActiveContextSubmenuKey(null);
  }, []);

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

  const { summaryLabel } = useExplorerSummary(filteredSchemaSections, language);
  const hasSearch = search.trim().length > 0;

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
  }, [dbType, pinnedTableSet, t, tableContextMenu, handleOpenTableInNewTab, handleOpenStructureDraft, handleCopyTableName, openQueryDraft, togglePinnedTable]);

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
    visibleTableCount: filteredSchemaSections.reduce((total, section) => total + section.tables.length, 0),
    visibleObjectCount: filteredSchemaSections.reduce(
      (total, section) => total + section.views.length + section.triggers.length + section.routines.length, 0
    ),
    language,
    t,
    pinnedTableSet,
    // Actions
    toggleDb,
    handleTableClick,
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
