import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { formatCountLabel, useI18n } from "../../i18n";

interface ExplorerSchemaSection {
  schemaName: string;
  tables: TableInfo[];
  views: SchemaObjectInfo[];
  triggers: SchemaObjectInfo[];
  routines: SchemaObjectInfo[];
}

interface ExplorerTableContextMenuState {
  table: Pick<TableInfo, "name" | "schema" | "row_count">;
  x: number;
  y: number;
}

interface ExplorerContextMenuItem {
  key: string;
  label?: string;
  action?: () => void;
  children?: ExplorerContextMenuItem[];
  divider?: boolean;
  danger?: boolean;
}

const EXPLORER_PINNED_TABLES_STORAGE_KEY = "tabler.explorerPinnedTables";
const EXPLORER_CONTEXT_MENU_WIDTH = 220;
const EXPLORER_CONTEXT_SUBMENU_WIDTH = 228;
const EXPLORER_CONTEXT_MENU_MAX_HEIGHT = 440;

function getQualifiedTableName(table: Pick<TableInfo, "name" | "schema">) {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

function quoteIdentifier(identifier: string, dbType?: string) {
  const quote = dbType === "mysql" || dbType === "mariadb" ? "`" : `"`;
  const escaped = identifier.split(quote).join(`${quote}${quote}`);
  return `${quote}${escaped}${quote}`;
}

function getQuotedQualifiedTableName(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  if (!table.schema) return quoteIdentifier(table.name, dbType);
  return `${quoteIdentifier(table.schema, dbType)}.${quoteIdentifier(table.name, dbType)}`;
}

function loadPinnedTablesByWorkspace() {
  if (typeof window === "undefined") return {} as Record<string, string[]>;

  try {
    const raw = window.localStorage.getItem(EXPLORER_PINNED_TABLES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
    );
  } catch {
    return {};
  }
}

async function copyToClipboard(value: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
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

  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [activeSchemaFilter, setActiveSchemaFilter] = useState<string>("all");
  const [isSchemaPickerOpen, setIsSchemaPickerOpen] = useState(false);
  const [showCreateWizard, setShowCreateWizard] = useState(false);
  const [tableContextMenu, setTableContextMenu] = useState<ExplorerTableContextMenuState | null>(null);
  const [activeContextSubmenuKey, setActiveContextSubmenuKey] = useState<string | null>(null);
  const [pinnedTablesByWorkspace, setPinnedTablesByWorkspace] = useState<Record<string, string[]>>(
    () => loadPinnedTablesByWorkspace()
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const schemaPickerRef = useRef<HTMLDivElement>(null);
  const tableContextMenuRef = useRef<HTMLDivElement>(null);
  const tableContextSubmenuRef = useRef<HTMLDivElement>(null);
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
  const tableWorkspaceKey =
    activeConnectionId && currentDatabase ? `${activeConnectionId}|${currentDatabase}` : "";
  const pinnedTableSet = useMemo(
    () => new Set(pinnedTablesByWorkspace[tableWorkspaceKey] ?? []),
    [pinnedTablesByWorkspace, tableWorkspaceKey]
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

  const openQueryDraft = (title: string, content: string) => {
    if (!activeConnectionId) return;
    addTab({
      id: `query-${crypto.randomUUID()}`,
      type: "query",
      title,
      connectionId: activeConnectionId,
      database: currentDatabase || undefined,
      content,
    });
  };

  const handleOpenTableInNewTab = (table: Pick<TableInfo, "name" | "schema">) => {
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
  };

  const handleOpenStructureDraft = (table: Pick<TableInfo, "name" | "schema">) => {
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
  };

  const buildOverviewScript = (table: Pick<TableInfo, "name" | "schema">) => {
    const qualified = getQuotedQualifiedTableName(table, activeConnection?.db_type);
    return `-- Overview for ${getQualifiedTableName(table)}
SELECT COUNT(*) AS total_rows FROM ${qualified};

SELECT *
FROM ${qualified}
LIMIT 100;`;
  };

  const buildSelectScript = (table: Pick<TableInfo, "name" | "schema">) => {
    const qualified = getQuotedQualifiedTableName(table, activeConnection?.db_type);
    return `SELECT *
FROM ${qualified}
LIMIT 1000;`;
  };

  const buildInsertTemplate = (table: Pick<TableInfo, "name" | "schema">) => {
    const qualified = getQuotedQualifiedTableName(table, activeConnection?.db_type);
    return `INSERT INTO ${qualified} (
  -- columns
)
VALUES (
  -- values
);`;
  };

  const buildUpdateTemplate = (table: Pick<TableInfo, "name" | "schema">) => {
    const qualified = getQuotedQualifiedTableName(table, activeConnection?.db_type);
    return `UPDATE ${qualified}
SET
  -- column = value
WHERE
  -- condition
;`;
  };

  const buildDeleteTemplate = (table: Pick<TableInfo, "name" | "schema">) => {
    const qualified = getQuotedQualifiedTableName(table, activeConnection?.db_type);
    return `DELETE FROM ${qualified}
WHERE
  -- condition
;`;
  };

  const buildCloneScript = (table: Pick<TableInfo, "name" | "schema">) => {
    const source = getQuotedQualifiedTableName(table, activeConnection?.db_type);
    const cloneName = quoteIdentifier(`${table.name}_copy`, activeConnection?.db_type);
    return `-- Clone ${getQualifiedTableName(table)}
CREATE TABLE ${cloneName} AS
SELECT *
FROM ${source};`;
  };

  const buildTruncateScript = (table: Pick<TableInfo, "name" | "schema">) => {
    const qualified = getQuotedQualifiedTableName(table, activeConnection?.db_type);
    if (activeConnection?.db_type === "sqlite") {
      return `DELETE FROM ${qualified};`;
    }
    return `TRUNCATE TABLE ${qualified};`;
  };

  const buildDropScript = (table: Pick<TableInfo, "name" | "schema">) => {
    const qualified = getQuotedQualifiedTableName(table, activeConnection?.db_type);
    return `DROP TABLE ${qualified};`;
  };

  const closeTableContextMenu = () => {
    setTableContextMenu(null);
    setActiveContextSubmenuKey(null);
  };

  const handleTableContextMenu = (event: React.MouseEvent, table: Pick<TableInfo, "name" | "schema" | "row_count">) => {
    event.preventDefault();
    event.stopPropagation();
    setTableContextMenu({
      table,
      x: event.clientX,
      y: event.clientY,
    });
    setActiveContextSubmenuKey(null);
  };

  const handleCopyTableName = async (table: Pick<TableInfo, "name" | "schema">) => {
    await copyToClipboard(getQualifiedTableName(table));
  };

  const togglePinnedTable = (table: Pick<TableInfo, "name" | "schema">) => {
    if (!tableWorkspaceKey) return;
    const qualifiedName = getQualifiedTableName(table);
    setPinnedTablesByWorkspace((previous) => {
      const current = previous[tableWorkspaceKey] ?? [];
      const next = current.includes(qualifiedName)
        ? current.filter((entry) => entry !== qualifiedName)
        : [qualifiedName, ...current];
      return {
        ...previous,
        [tableWorkspaceKey]: next,
      };
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
      const leftQualified = getQualifiedTableName(left);
      const rightQualified = getQualifiedTableName(right);
      const leftPinned = pinnedTableSet.has(leftQualified);
      const rightPinned = pinnedTableSet.has(rightQualified);

      if (leftPinned !== rightPinned) {
        return leftPinned ? -1 : 1;
      }

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
  }, [actualTables, filteredSchemaObjects, pinnedTableSet]);

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
    [schemaSections, t]
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
  const summaryLabel = `${formatCountLabel(language, visibleTableCount, {
    one: "table",
    other: "tables",
    vi: "bảng",
  })} | ${formatCountLabel(language, visibleObjectCount, {
    one: "object",
    other: "objects",
    vi: "đối tượng",
  })} | ${formatCountLabel(language, visibleSchemaCount, {
    one: "schema",
    other: "schemas",
    vi: "schema",
  })}`;

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
        action: () => openQueryDraft(`${table.name} overview`, buildOverviewScript(table)),
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
            action: () => openQueryDraft(`${table.name} export`, buildSelectScript(table)),
          },
          {
            key: "export-copy",
            label: t("explorer.context.copySelect"),
            action: () => void copyToClipboard(buildSelectScript(table)),
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
            action: () => openQueryDraft(`${table.name} insert`, buildInsertTemplate(table)),
          },
          {
            key: "import-guide",
            label: t("explorer.context.importGuide"),
            action: () =>
              openQueryDraft(
                `${table.name} import`,
                `-- Import guide for ${qualifiedName}\n-- Paste your INSERT statements or load a .sql file here.\n\n${buildInsertTemplate(table)}`
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
            action: () => openQueryDraft(`${table.name} query`, buildSelectScript(table)),
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
            action: () => void copyToClipboard(buildSelectScript(table)),
          },
          {
            key: "copy-insert",
            label: t("explorer.context.copyInsert"),
            action: () => void copyToClipboard(buildInsertTemplate(table)),
          },
          {
            key: "copy-update",
            label: t("explorer.context.copyUpdate"),
            action: () => void copyToClipboard(buildUpdateTemplate(table)),
          },
          {
            key: "copy-delete",
            label: t("explorer.context.copyDelete"),
            action: () => void copyToClipboard(buildDeleteTemplate(table)),
          },
        ],
      },
      { key: "divider-danger", divider: true },
      {
        key: "clone",
        label: t("explorer.context.clone"),
        action: () => openQueryDraft(`${table.name} clone`, buildCloneScript(table)),
      },
      {
        key: "truncate",
        label: t("explorer.context.truncate"),
        action: () => openQueryDraft(`${table.name} truncate`, buildTruncateScript(table)),
        danger: true,
      },
      {
        key: "delete",
        label: t("explorer.context.delete"),
        action: () => openQueryDraft(`${table.name} delete`, buildDropScript(table)),
        danger: true,
      },
    ];
  }, [
    buildCloneScript,
    buildDeleteTemplate,
    buildDropScript,
    buildInsertTemplate,
    buildOverviewScript,
    buildSelectScript,
    buildTruncateScript,
    buildUpdateTemplate,
    handleCopyTableName,
    handleOpenStructureDraft,
    handleOpenTableInNewTab,
    openQueryDraft,
    pinnedTableSet,
    t,
    tableContextMenu,
  ]);

  const menuLeft = tableContextMenu
    ? Math.min(
        tableContextMenu.x,
        window.innerWidth - EXPLORER_CONTEXT_MENU_WIDTH - EXPLORER_CONTEXT_SUBMENU_WIDTH - 24
      )
    : 0;
  const menuTop = tableContextMenu
    ? Math.min(tableContextMenu.y, window.innerHeight - EXPLORER_CONTEXT_MENU_MAX_HEIGHT)
    : 0;
  const activeContextSubmenu =
    tableContextMenuItems.find((item) => item.key === activeContextSubmenuKey && item.children)?.children ?? null;
  const submenuLeft =
    menuLeft + EXPLORER_CONTEXT_MENU_WIDTH + 8 + EXPLORER_CONTEXT_SUBMENU_WIDTH <= window.innerWidth - 12
      ? menuLeft + EXPLORER_CONTEXT_MENU_WIDTH + 8
      : menuLeft - EXPLORER_CONTEXT_SUBMENU_WIDTH - 8;

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

      const targetNode = event.target as Node;
      if (
        !tableContextMenuRef.current?.contains(targetNode) &&
        !tableContextSubmenuRef.current?.contains(targetNode)
      ) {
        closeTableContextMenu();
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
  }, []);

  useEffect(() => {
    closeTableContextMenu();
  }, [currentDatabase, activeConnectionId, search]);

  if (!activeConnectionId || !connectedIds.has(activeConnectionId)) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 text-center text-[var(--text-muted)]">
        <Database className="w-12 h-12 mb-4 opacity-15" />
        <p className="text-sm font-medium opacity-60">{t("explorer.noActiveConnection")}</p>
        <p className="text-xs mt-1.5 opacity-40">{t("explorer.connectToExplore")}</p>
      </div>
    );
  }

  return (
    <div className="explorer-shell">
      <div className="panel-header panel-header-rich explorer-header">
        <div className="explorer-header-bar">
          <div className="explorer-header-identity">
            <div className="explorer-header-line">
              <h2 className="explorer-header-title">{t("explorer.title")}</h2>
            </div>

            <div className="explorer-header-context">
              <div className="explorer-workspace-pill" title={currentDatabase || undefined}>
                <span className="explorer-workspace-dot" />
                <span className="explorer-workspace-label">{compactDatabaseName || t("explorer.workspace")}</span>
              </div>
              <span className="explorer-header-summary-text">{summaryLabel}</span>
            </div>
          </div>

          <div className="explorer-header-actions">
            {supportsCreateWizard && (
              <button
                type="button"
                onClick={() => setShowCreateWizard(true)}
                className="explorer-header-btn"
                title={t("explorer.createTitle")}
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t("explorer.create")}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => void handleDisconnect()}
              className="explorer-header-btn danger"
              title={t("explorer.disconnectTitle")}
            >
              <PlugZap className="w-3.5 h-3.5" />
              <span>{t("explorer.disconnect")}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleRefresh()}
              className="panel-header-action explorer-refresh-btn"
              title={t("explorer.refreshTitle")}
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
            placeholder={t("explorer.searchPlaceholder")}
            className="sidebar-search-input"
          />
        </div>
        <div className="explorer-search-hint">
          <span>
            {hasSearch
              ? `${formatCountLabel(language, visibleTableCount + visibleObjectCount, {
                  one: "match",
                  other: "matches",
                  vi: "kết quả",
                })} | ${formatCountLabel(language, visibleSchemaCount, {
                  one: "schema",
                  other: "schemas",
                  vi: "schema",
                })}`
              : t("explorer.browseHint")}
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
                        ? t("explorer.tablesReady", { count: tableCount ?? 0 })
                        : t("explorer.switchWorkspace")}
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
                      <span>{t("explorer.databaseObjects")}</span>
                      <span className="explorer-table-panel-caption">
                        {activeSchemaFilter === "all"
                          ? t("explorer.groupedBySchema")
                          : t("explorer.showingSchemaByDefault", { schema: activeSchemaFilter })}
                      </span>
                    </div>
                    <span className="explorer-table-panel-total">
                      {hasSearch
                        ? formatCountLabel(language, visibleTableCount + visibleObjectCount, {
                            one: "shown",
                            other: "shown",
                            vi: "đang hiện",
                          })
                        : `${formatCountLabel(language, visibleTableCount, {
                            one: "table",
                            other: "tables",
                            vi: "bảng",
                          })} | ${formatCountLabel(language, visibleObjectCount, {
                            one: "object",
                            other: "objects",
                            vi: "đối tượng",
                          })}`}
                    </span>
                  </div>

                  {availableSchemaNames.length > 1 && (
                    <div className="explorer-schema-toolbar">
                      <span className="explorer-schema-toolbar-label">{t("explorer.schema")}</span>
                      <div className="explorer-schema-picker" ref={schemaPickerRef}>
                        <button
                          type="button"
                          className={`explorer-schema-picker-trigger ${isSchemaPickerOpen ? "open" : ""}`}
                          onClick={() => setIsSchemaPickerOpen((open) => !open)}
                        >
                          <span className="explorer-schema-picker-value">
                            {activeSchemaFilter === "all" ? t("explorer.allSchemas") : activeSchemaFilter}
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
                      {t("explorer.loadingObjects")}
                    </div>
                  ) : filteredSchemaSections.length === 0 ? (
                    <div className="explorer-table-status empty">
                      {search ? t("explorer.noObjectsMatch") : t("explorer.noObjectsFound")}
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
                              <div className="explorer-object-group-head">{t("explorer.tablesGroup")}</div>
                              {section.tables.map((table) => (
                                <div
                                  key={`table-${section.schemaName}-${table.name}`}
                                  className={`explorer-table-row ${
                                    tableContextMenu &&
                                    getQualifiedTableName(tableContextMenu.table) === getQualifiedTableName(table)
                                      ? "context-active"
                                      : ""
                                  }`}
                                  onContextMenu={(event) => handleTableContextMenu(event, table)}
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
                                        {t("explorer.openDataRows")}
                                        {table.row_count != null
                                          ? ` | ${table.row_count.toLocaleString()} ${formatCountLabel(language, table.row_count, {
                                              one: "row",
                                              other: "rows",
                                              vi: "dòng",
                                            }).replace(/^\d+\s+/, "")}`
                                          : ""}
                                      </span>
                                    </div>
                                  </button>
                                  <button
                                    onClick={(e) => handleStructureClick(e, table)}
                                    className="explorer-structure-btn"
                                    title={t("explorer.viewStructure")}
                                  >
                                    <Columns className="w-3.5 h-3.5" />
                                    <span>{t("explorer.structure")}</span>
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}

                          {section.views.length > 0 && (
                            <div className="explorer-object-group">
                              <div className="explorer-object-group-head">{t("explorer.viewsGroup")}</div>
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
                                      <span className="explorer-table-meta">{t("explorer.viewsGroup")}</span>
                                    </div>
                                  </button>
                                  <button
                                    onClick={(e) =>
                                      handleStructureClick(e, { name: view.name, schema: view.schema })
                                    }
                                    className="explorer-structure-btn"
                                    title={t("explorer.viewStructure")}
                                  >
                                    <Columns className="w-3.5 h-3.5" />
                                    <span>{t("explorer.structure")}</span>
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}

                          {section.triggers.length > 0 && (
                            <div className="explorer-object-group">
                              <div className="explorer-object-group-head">{t("explorer.triggersGroup")}</div>
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
                                        {trigger.related_table || t("explorer.triggersGroup")}
                                      </span>
                                    </div>
                                  </div>
                                  <button
                                    onClick={(e) => handleObjectSqlClick(e, trigger)}
                                    className="explorer-structure-btn"
                                    title={`${t("common.open")} SQL`}
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
                              <div className="explorer-object-group-head">{t("explorer.routinesGroup")}</div>
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
                                    title={`${t("common.open")} SQL`}
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

      {databases.length === 0 && <div className="explorer-empty">{t("explorer.noObjectsFound")}</div>}
      </div>

      {tableContextMenu &&
        createPortal(
          <>
            <div
              ref={tableContextMenuRef}
              className="explorer-context-menu"
              style={{ left: menuLeft, top: menuTop }}
              onContextMenu={(event) => event.preventDefault()}
            >
              {tableContextMenuItems.map((item) =>
                item.divider ? (
                  <div key={item.key} className="explorer-context-menu-divider" />
                ) : (
                  <button
                    key={item.key}
                    type="button"
                    className={`explorer-context-menu-item ${item.danger ? "danger" : ""} ${
                      activeContextSubmenuKey === item.key ? "active" : ""
                    }`}
                    onMouseEnter={() => setActiveContextSubmenuKey(item.children ? item.key : null)}
                    onClick={() => {
                      if (item.children) {
                        setActiveContextSubmenuKey(item.key);
                        return;
                      }
                      item.action?.();
                      closeTableContextMenu();
                    }}
                  >
                    <span>{item.label}</span>
                    {item.children ? <ChevronRight className="w-3.5 h-3.5" /> : null}
                  </button>
                )
              )}
            </div>

            {activeContextSubmenu && (
              <div
                ref={tableContextSubmenuRef}
                className="explorer-context-menu explorer-context-menu-submenu"
                style={{ left: submenuLeft, top: menuTop + 28 }}
                onContextMenu={(event) => event.preventDefault()}
                onMouseLeave={() => setActiveContextSubmenuKey(null)}
              >
                {activeContextSubmenu.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="explorer-context-menu-item"
                    onClick={() => {
                      item.action?.();
                      closeTableContextMenu();
                    }}
                  >
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            )}
          </>,
          document.body
        )}

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
