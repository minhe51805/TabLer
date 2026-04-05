import { Database, ChevronDown, ChevronRight, Columns, Eye, FileCode, GitBranch, Loader2, Table, Filter } from "lucide-react";
import type { DatabaseInfo, SchemaObjectInfo, TableInfo } from "../../../types";
import { formatCountLabel } from "../../../i18n";
import type { AppLanguage } from "../../../i18n";
import { getQualifiedTableName } from "../SidebarUtils";
import type { ExplorerSchemaSection } from "../hooks/useTreeState";
import type { MixedStateFilter, CheckboxFilterState } from "../hooks/use-sidebar";

// ---------------------------------------------------------------------------
// Mixed-state checkbox SVG icon
// ---------------------------------------------------------------------------

function MixedCheckbox({ state, onChange, title }: {
  state: CheckboxFilterState;
  onChange: (next: CheckboxFilterState) => void;
  title?: string;
}) {
  const handleClick = () => {
    if (state === "indeterminate") onChange("checked");
    else if (state === "checked") onChange("unchecked");
    else onChange("indeterminate");
  };

  return (
    <button
      type="button"
      className={`mixed-checkbox mixed-checkbox--${state}`}
      onClick={handleClick}
      title={title ?? `State: ${state}. Click to cycle.`}
      aria-label={`Filter: ${state}`}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        {state === "checked" ? (
          // Checked: filled box with check
          <>
            <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill="var(--accent)" stroke="var(--accent)" strokeWidth="1" />
            <path d="M3.5 7L5.5 9L10.5 4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </>
        ) : state === "unchecked" ? (
          // Unchecked: box with X
          <>
            <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill="none" stroke="var(--border)" strokeWidth="1.5" />
            <path d="M4 4L10 10M10 4L4 10" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" />
          </>
        ) : (
          // Indeterminate: filled box with dash
          <>
            <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill="var(--bg-secondary)" stroke="var(--border)" strokeWidth="1.5" />
            <path d="M3.5 7H10.5" stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round" />
          </>
        )}
      </svg>
    </button>
  );
}

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: any, opts?: Record<string, any>) => string;
  // Interactions
  onToggleDb: (db: DatabaseInfo) => void;
  onTableClick: (table: Pick<TableInfo, "name" | "schema">) => void;
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
  visibleTableCount,
  visibleObjectCount,
  language,
  t,
  onToggleDb,
  onTableClick,
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
                    <section key={section.schemaName} className="explorer-schema-group">
                      {/* Schema group header with mixed-state checkbox */}
                      <div className="explorer-schema-head">
                        <MixedCheckbox
                          state={getSchemaGroupFilterState(section.schemaName, mixedStateFilter)}
                          onChange={(next) => {
                            // Toggle all tables in this schema group
                            const items = section.tables.map((t) => t.name);
                            items.forEach((itemName) => {
                              onMixedStateToggle(section.schemaName, itemName, next);
                            });
                          }}
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
                              return (
                                <div
                                  key={`table-${section.schemaName}-${table.name}`}
                                  className={`explorer-table-row ${
                                    tableContextMenu &&
                                    getQualifiedTableName(tableContextMenu.table) === getQualifiedTableName(table)
                                      ? "context-active"
                                      : ""
                                  }`}
                                  onContextMenu={(event) => onTableContextMenu(event, table)}
                                >
                                  {/* Mixed-state checkbox */}
                                  <MixedCheckbox
                                    state={itemState}
                                    onChange={(next) => {
                                      onMixedStateToggle(section.schemaName, table.name, next);
                                    }}
                                    title={`Table filter: ${itemState} — checked=include, unchecked=exclude, indeterminate=no filter`}
                                  />
                                  <button
                                    onClick={() => onTableClick(table)}
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
                                    onClick={(e) => onStructureClick(e, table)}
                                    className="explorer-structure-btn"
                                    title={t("explorer.viewStructure")}
                                  >
                                    <Columns className="w-3.5 h-3.5" />
                                    <span>{t("explorer.structure")}</span>
                                  </button>
                                </div>
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
                                <div
                                  key={`view-${section.schemaName}-${view.name}`}
                                  className="explorer-table-row"
                                >
                                  <MixedCheckbox
                                    state={itemState}
                                    onChange={(next) => onMixedStateToggle(section.schemaName, view.name, next)}
                                    title={`View filter: ${itemState}`}
                                  />
                                  <button
                                    onClick={() => onTableClick({ name: view.name, schema: view.schema })}
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
                                      onStructureClick(e, { name: view.name, schema: view.schema })
                                    }
                                    className="explorer-structure-btn"
                                    title={t("explorer.viewStructure")}
                                  >
                                    <Columns className="w-3.5 h-3.5" />
                                    <span>{t("explorer.structure")}</span>
                                  </button>
                                </div>
                              );
                            })}
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
                                  onClick={(e) => onObjectSqlClick(e, trigger)}
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
                                  onClick={(e) => onObjectSqlClick(e, routine)}
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