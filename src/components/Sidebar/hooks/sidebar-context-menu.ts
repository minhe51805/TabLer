import type { useI18n } from "../../../i18n";
import type { AppLanguage } from "../../../i18n";
import type { DatabaseType, TableInfo } from "../../../types";
import type { ExplorerContextMenuItem } from "../components/ContextMenu";
import type { CodegenTarget } from "../../../utils/schema-codegen";
import { getBulkActionsCopy } from "../bulk-actions-copy";
import { getCodegenCopy } from "../codegen-copy";
import { getExportFormatsCopy } from "../../../utils/export-formats-copy";
import type { ExportFormatInfo, TableExportFormat } from "../../../utils/export-formats";
import { getSeedRowsCopy } from "../../GenerateTestRows/seed-rows-copy";
import { getQualifiedTableName, copyToClipboard } from "../SidebarUtils";
import {
  buildCloneScript,
  buildDeleteTemplate,
  buildDropScript,
  buildInsertTemplate,
  buildOverviewScript,
  buildSelectScript,
  buildTruncateScript,
  buildUpdateTemplate,
} from "./sidebar-filter-scripts";

type TFunction = ReturnType<typeof useI18n>["t"];
type BulkCopy = ReturnType<typeof getBulkActionsCopy>;
type CodegenCopy = ReturnType<typeof getCodegenCopy>;

/** Everything the table context menu needs from the sidebar hook — the menu
 *  tree itself is pure data, so it builds here instead of inside the hook. */
export interface TableContextMenuDeps {
  tableContextMenu: {
    table: TableInfo;
    tables?: TableInfo[];
  } | null;
  pinnedTableSet: Set<string>;
  dbType: DatabaseType | undefined;
  language: AppLanguage;
  t: TFunction;
  bulkCopy: BulkCopy;
  codegenCopy: CodegenCopy;
  onOpenTableInNewTab: (table: TableInfo) => void;
  onOpenStructureDraft: (table: TableInfo) => void;
  openQueryDraft: (title: string, sql: string) => void;
  onCopyTableName: (table: TableInfo) => void;
  onCopyAsCode: (table: TableInfo, target: CodegenTarget) => void;
  onGenerateTableDocs: (table: TableInfo) => void;
  onOpenQueryBuilder: (tableName: string) => void;
  onGenerateTestRows: (table: TableInfo) => void;
  onTogglePinnedTable: (table: TableInfo) => void;
  onRunMaintenanceCommand: (command: string, tableName: string) => void;
  onBulkExport: (format: TableExportFormat) => void;
  onOpenBulkDrop: () => void;
  /** Export formats compiled into the backend (from `get_export_formats`). */
  exportFormats: ExportFormatInfo[];
}

/** Right-click menu for a table (or a multi-table selection): open/copy/
 *  codegen/export/import/maintenance/danger actions, engine-gated. */
export function buildTableContextMenuItems(deps: TableContextMenuDeps): ExplorerContextMenuItem[] {
  const {
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
    onOpenQueryBuilder: handleOpenQueryBuilder,
    onGenerateTestRows: handleGenerateTestRows,
    onTogglePinnedTable: togglePinnedTable,
    onRunMaintenanceCommand: runMaintenanceCommand,
    exportFormats,
    onBulkExport: handleBulkExport,
    onOpenBulkDrop: openBulkDrop,
  } = deps;

  if (!tableContextMenu) return [];

  // Multi-selection menu: bulk actions only (export + guarded drop).
  if (tableContextMenu.tables && tableContextMenu.tables.length > 1) {
    const count = tableContextMenu.tables.length;
    const exportCopy = getExportFormatsCopy(language);
    return [
      {
        key: "bulk-export",
        label: `${bulkCopy.exportTables} (${count})`,
        children: exportFormats.map((format) => ({
          key: `bulk-export-${format.id}`,
          label: exportCopy.formats[format.id]?.label ?? format.label,
          action: () => void handleBulkExport(format.id),
        })),
      },
      { key: "bulk-divider", divider: true },
      {
        key: "bulk-drop",
        label: `${bulkCopy.dropTables} (${count})`,
        action: () => void openBulkDrop(),
        danger: true,
      },
    ];
  }

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
      key: "generate-docs",
      label: t("explorer.context.generateDocs"),
      action: () => void handleGenerateTableDocs(table),
    },
    {
      key: "copy-as-code",
      label: codegenCopy.menuLabel,
      children: (["typescript", "zod", "rust", "go", "jsonschema"] as const).map((target) => ({
        key: `codegen-${target}`,
        label: codegenCopy.targets[target],
        action: () => void handleCopyAsCode(table, target),
      })),
    },
    {
      key: "visual-query-builder",
      label: t("querybuilder.title"),
      action: () => void handleOpenQueryBuilder(table.name),
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
              `-- Import guide for ${qualifiedName}\n-- Paste your INSERT statements or load a .sql file here.\n\n${buildInsertTemplate(table, dbType)}`,
            ),
        },
      ],
    },
    {
      key: "generate-test-rows",
      label: getSeedRowsCopy(language).menuItem,
      action: () => handleGenerateTestRows(table),
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
        ...([
          "postgresql",
          "greenplum",
          "cockroachdb",
          "redshift",
          "vertica",
          "sqlite",
          "libsql",
          "cloudflare_d1",
        ].includes(dbType || "")
          ? [
              {
                key: "maintenance-vacuum",
                label: "VACUUM",
                action: () => void runMaintenanceCommand("vacuum", table.name),
              },
            ]
          : []),
        // ANALYZE: PostgreSQL, MySQL, SQLite
        ...([
          "postgresql",
          "greenplum",
          "cockroachdb",
          "redshift",
          "vertica",
          "mysql",
          "mariadb",
          "sqlite",
          "libsql",
          "cloudflare_d1",
        ].includes(dbType || "")
          ? [
              {
                key: "maintenance-analyze",
                label: "ANALYZE",
                action: () => void runMaintenanceCommand("analyze", table.name),
              },
            ]
          : []),
        // OPTIMIZE TABLE: MySQL, ClickHouse
        ...(["mysql", "mariadb", "clickhouse"].includes(dbType || "")
          ? [
              {
                key: "maintenance-optimize",
                label: "OPTIMIZE TABLE",
                action: () => void runMaintenanceCommand("optimize", table.name),
              },
            ]
          : []),
        // REINDEX: PostgreSQL, SQLite
        ...([
          "postgresql",
          "greenplum",
          "cockroachdb",
          "redshift",
          "vertica",
          "sqlite",
          "libsql",
          "cloudflare_d1",
        ].includes(dbType || "")
          ? [
              {
                key: "maintenance-reindex",
                label: "REINDEX",
                action: () => void runMaintenanceCommand("reindex", table.name),
              },
            ]
          : []),
        // CHECK TABLE: MySQL, PostgreSQL
        ...(["mysql", "mariadb", "postgresql", "greenplum", "cockroachdb"].includes(dbType || "")
          ? [
              {
                key: "maintenance-check",
                label: "CHECK TABLE",
                action: () => void runMaintenanceCommand("check_table", table.name),
              },
            ]
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
}
