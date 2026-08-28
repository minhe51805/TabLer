import { memo, useCallback } from "react";
import { Database, ChevronDown, ChevronRight, Loader2, Filter } from "lucide-react";
import type { DatabaseInfo, SchemaObjectInfo, TableInfo } from "../../../types";
import type { AppLanguage } from "../../../i18n";
import { getQualifiedTableName } from "../SidebarUtils";
import type { ExplorerSchemaSection } from "../hooks/useTreeState";
import type { MixedStateFilter, CheckboxFilterState } from "../hooks/use-sidebar";
import {
  MixedCheckbox,
  StaticObjectRow,
  TableRow,
  ViewRow,
} from "./DatabaseTreeItems";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DatabaseTreeProps {
  databases: DatabaseInfo[];
  currentDatabase: string | null;
  tables: TableInfo[];
  schemaObjects: SchemaObjectInfo[];
  isLoadingTables: boolean;
  expandedDbs: Set<string>;
  filteredSchemaSections: ExplorerSchemaSection[];
  activeSchemaFilter: string;
  availableSchemaNames: string[];
  schemaFilterOptions: { value: string; label: string; count: number }[];
  activeConnectionDbType?: string;
  hasSearch: boolean;
  visibleTableCount: number;
  visibleObjectCount: number;
  language: AppLanguage;

  t: (key: import("../../../i18n").TranslationKey, opts?: Record<string, string | number>) => string;
  // Interactions
  onToggleDb: (db: DatabaseInfo) => void;
  onTableClick: (table: Pick<TableInfo, "name" | "schema">) => void;
  onTableDoubleClick?: (table: Pick<TableInfo, "name" | "schema">) => void;
  onStructureClick: (e: React.MouseEvent, table: Pick<TableInfo, "name" | "schema">) => void;
  onObjectSqlClick: (e: React.MouseEvent, object: SchemaObjectInfo) => void;
  onTableContextMenu: (event: React.MouseEvent, table: Pick<TableInfo, "name" | "schema" | "row_count">) => void;
  onSchemaFilterChange: (schema: string) => void;
  onSchemaPickerToggle: () => void;
  onSchemaPickerClose: () => void;
  isSchemaPickerOpen: boolean;
  schemaPickerRef: React.RefObject<HTMLDivElement | null>;
  tableContextMenu?: { table: Pick<TableInfo, "name" | "schema"> } | null;
  // Mixed-state filter props
  mixedStateFilter: MixedStateFilter;
  onMixedStateToggle: (schemaName: string, itemName: string, nextState: CheckboxFilterState) => void;
  getMixedStateFilterForTable: (tableName: string, schemaName: string) => MixedStateFilter;
}

function getLastPathSegment(value?: string | null) {
  if (!value) return "";
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
}

// ---------------------------------------------------------------------------
// Memoized schema group section
// ---------------------------------------------------------------------------

interface SchemaGroupProps {
  section: ExplorerSchemaSection;
  mixedStateFilter: MixedStateFilter;
  onMixedStateToggle: DatabaseTreeProps["onMixedStateToggle"];
  getMixedStateFilterForTable: DatabaseTreeProps["getMixedStateFilterForTable"];
  onTableClick: DatabaseTreeProps["onTableClick"];
  onTableDoubleClick?: DatabaseTreeProps["onTableDoubleClick"];
  onStructureClick: DatabaseTreeProps["onStructureClick"];
  onObjectSqlClick: DatabaseTreeProps["onObjectSqlClick"];
  onTableContextMenu: DatabaseTreeProps["onTableContextMenu"];
  contextQualifiedName: string | null;
  language: AppLanguage;
  t: (key: import("../../../i18n").TranslationKey, opts?: Record<string, string | number>) => string;
}

const SchemaGroup = memo(function SchemaGroup({
  section,
  mixedStateFilter,
  onMixedStateToggle,
  getMixedStateFilterForTable,
  onTableClick,
  onTableDoubleClick,
  onStructureClick,
  onObjectSqlClick,
  onTableContextMenu,
  contextQualifiedName,
  language,
  t,
}: SchemaGroupProps) {
  const groupState = getSchemaGroupFilterState(section.schemaName, mixedStateFilter);

  const handleGroupToggle = useCallback(
    (next: CheckboxFilterState) => {
      // Toggle all tables in this schema group
      for (const item of section.tables) {
        onMixedStateToggle(section.schemaName, item.name, next);
      }
    },
    [onMixedStateToggle, section],
  );

  return (
    <section className="explorer-schema-group">
      {/* Schema group header with mixed-state checkbox */}
      <div className="explorer-schema-head">
        <MixedCheckbox
          state={groupState}
          onChange={handleGroupToggle}
          title={`Schema filter: ${section.schemaName}`}
        />
        <span className="explorer-schema-name">{section.schemaName}</span>
        <span className="explorer-schema-count">
          {section.tables.length + section.views.length + section.triggers.length + section.routines.length}
        </span>
      </div>

      <div className="explorer-schema-list">
        {section.tables.length > 0 && (
          <div className="explorer-object-group">
            <div className="explorer-object-group-head">{t("explorer.tablesGroup")}</div>
            {section.tables.map((table) => {
              const tableFilter = getMixedStateFilterForTable(table.name, section.schemaName);
              const itemState = getItemFilterState(table.name, section.schemaName, tableFilter);
              const isContextActive =
                contextQualifiedName !== null &&
                contextQualifiedName === getQualifiedTableName(table);
              return (
                <TableRow
                  key={`table-${section.schemaName}-${table.name}`}
                  table={table}
                  itemState={itemState}
                  isContextActive={isContextActive}
                  onTableClick={onTableClick}
                  onTableDoubleClick={onTableDoubleClick}
                  onStructureClick={onStructureClick}
                  onTableContextMenu={onTableContextMenu}
                  schemaName={section.schemaName}
                  language={language}
                  t={t}
                  onMixedStateToggle={onMixedStateToggle}
                />
              );
            })}
          </div>
        )}

        {section.views.length > 0 && (
          <div className="explorer-object-group">
            <div className="explorer-object-group-head">{t("explorer.viewsGroup")}</div>
            {section.views.map((view) => {
              const tableFilter = getMixedStateFilterForTable(view.name, section.schemaName);
              const itemState = getItemFilterState(view.name, section.schemaName, tableFilter);
              return (
                <ViewRow
                  key={`view-${section.schemaName}-${view.name}`}
                  view={view}
                  itemState={itemState}
                  onTableClick={onTableClick}
                  onTableDoubleClick={onTableDoubleClick}
                  onStructureClick={onStructureClick}
                  schemaName={section.schemaName}
                  language={language}
                  t={t}
                  onMixedStateToggle={onMixedStateToggle}
                />
              );
            })}
          </div>
        )}

        {section.triggers.length > 0 && (
          <div className="explorer-object-group">
            <div className="explorer-object-group-head">{t("explorer.triggersGroup")}</div>
            {section.triggers.map((trigger) => (
              <StaticObjectRow
                key={`trigger-${section.schemaName}-${trigger.name}`}
                object={trigger}
                metaText={trigger.related_table || t("explorer.triggersGroup")}
                icon="GitBranch"
                onObjectSqlClick={onObjectSqlClick}
                t={t}
              />
            ))}
          </div>
        )}

        {section.routines.length > 0 && (
          <div className="explorer-object-group">
            <div className="explorer-object-group-head">{t("explorer.routinesGroup")}</div>
            {section.routines.map((routine) => (
              <StaticObjectRow
                key={`routine-${section.schemaName}-${routine.name}`}
                object={routine}
                metaText={routine.object_type}
                icon="FileCode"
                onObjectSqlClick={onObjectSqlClick}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DatabaseTree({
  databases,
  currentDatabase,
  tables,
  isLoadingTables,
  expandedDbs,
  filteredSchemaSections,
  activeSchemaFilter,
  availableSchemaNames,
  schemaFilterOptions,
  activeConnectionDbType,
  hasSearch,
  language,
  t,
  onToggleDb,
  onTableClick,
  onTableDoubleClick,
  onStructureClick,
  onObjectSqlClick,
  onTableContextMenu,
  onSchemaFilterChange,
  onSchemaPickerToggle,
  onSchemaPickerClose,
  isSchemaPickerOpen,
  schemaPickerRef,
  tableContextMenu,
  mixedStateFilter,
  onMixedStateToggle,
  getMixedStateFilterForTable,
}: DatabaseTreeProps) {
  const contextQualifiedName = tableContextMenu
    ? getQualifiedTableName(tableContextMenu.table)
    : null;

  return (
    <div className="explorer-tree-scroll">
      {databases.map((db) => {
        const isExpanded = expandedDbs.has(db.name);
        const isCurrent = currentDatabase === db.name;
        const tableCount = isCurrent ? tables.length : null;
        const displayDatabaseName =
          activeConnectionDbType === "sqlite" ? getLastPathSegment(db.name) : db.name;

        return (
          <section
            key={db.name}
            className={`explorer-db-section ${isCurrent ? "active" : ""}`}
          >
            <button
              data-testid={isCurrent ? "database-current" : undefined}
              onClick={() => onToggleDb(db)}
              className={`explorer-db-button ${isCurrent ? "active" : ""}`}
            >
              {isExpanded ? (
                <ChevronDown className="w-4 h-4 shrink-0 explorer-db-chevron" />
              ) : (
                <ChevronRight className="w-4 h-4 shrink-0 explorer-db-chevron" />
              )}
              <div className="explorer-db-icon">
                <Database className="explorer-db-glyph w-4 h-4 shrink-0" />
              </div>
              <div className="explorer-db-copy">
                <div className="explorer-db-title-row">
                  <span className="explorer-db-name" title={db.name}>{displayDatabaseName}</span>
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
                {availableSchemaNames.length > 1 && (
                  <div className="explorer-schema-toolbar">
                    <span className="explorer-schema-toolbar-label">{t("explorer.schema")}</span>
                    <div className="explorer-schema-picker" ref={schemaPickerRef}>
                      <button
                        type="button"
                        className={`explorer-schema-picker-trigger ${isSchemaPickerOpen ? "open" : ""}`}
                        onClick={onSchemaPickerToggle}
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
                              onClick={() => {
                                onSchemaFilterChange(option.value);
                                onSchemaPickerClose();
                              }}
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

                {/* Mixed-state filter toolbar */}
                {mixedStateFilter.isActive && (
                  <div className="explorer-mixed-filter-bar">
                    <Filter className="w-3.5 h-3.5 shrink-0" />
                    <span className="explorer-mixed-filter-label">
                      Filter active — checked = included, unchecked = excluded
                    </span>
                  </div>
                )}

                {isLoadingTables ? (
                  <div className="explorer-table-status">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {t("explorer.loadingObjects")}
                  </div>
                ) : filteredSchemaSections.length === 0 ? (
                  <div className="explorer-table-status empty">
                    {hasSearch ? t("explorer.noObjectsMatch") : t("explorer.noObjectsFound")}
                  </div>
                ) : (
                  filteredSchemaSections.map((section) => (
                    <SchemaGroup
                      key={section.schemaName}
                      section={section}
                      mixedStateFilter={mixedStateFilter}
                      onMixedStateToggle={onMixedStateToggle}
                      getMixedStateFilterForTable={getMixedStateFilterForTable}
                      onTableClick={onTableClick}
                      onTableDoubleClick={onTableDoubleClick}
                      onStructureClick={onStructureClick}
                      onObjectSqlClick={onObjectSqlClick}
                      onTableContextMenu={onTableContextMenu}
                      contextQualifiedName={contextQualifiedName}
                      language={language}
                      t={t}
                    />
                  ))
                )}
              </div>
            )}
          </section>
        );
      })}

      {databases.length === 0 && <div className="explorer-empty">{t("explorer.noObjectsFound")}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: get schema group filter state
// ---------------------------------------------------------------------------

function getSchemaGroupFilterState(
  schemaName: string,
  filter: MixedStateFilter,
): CheckboxFilterState {
  const checked = filter.checkedItems[schemaName];
  const unchecked = filter.uncheckedItems[schemaName];
  if (!checked && !unchecked) return "indeterminate";
  if (checked && unchecked) return "indeterminate";
  if (checked && checked.size > 0) return "checked";
  if (unchecked && unchecked.size > 0) return "unchecked";
  return "indeterminate";
}

function getItemFilterState(
  item: string,
  schema: string,
  filter: MixedStateFilter,
): CheckboxFilterState {
  if (!filter.isActive) return "indeterminate";
  if (filter.uncheckedItems[schema]?.has(item)) return "unchecked";
  if (filter.checkedItems[schema]?.has(item)) return "checked";
  return "indeterminate";
}
