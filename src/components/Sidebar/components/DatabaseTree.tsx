import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
import {
  estimateExplorerItemSize,
  EXPLORER_GROUP_LABEL_KEYS,
  flattenExplorerSections,
  type ExplorerFlatItem,
} from "./explorer-virtualization";

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
// Virtualized schema rows (freeze-audit P1)
// ---------------------------------------------------------------------------

interface VirtualizedSchemaRowsProps {
  sections: ExplorerSchemaSection[];
  /** The `.explorer-tree-scroll` element — the actual vertical scroller. */
  getScrollElement: () => HTMLElement | null;
  /** Changes whenever layout above the panel may shift (expand/collapse, db switch). */
  layoutKey: string;
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

const VirtualizedSchemaRows = memo(function VirtualizedSchemaRows({
  sections,
  getScrollElement,
  layoutKey,
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
}: VirtualizedSchemaRowsProps) {
  const flatItems = useMemo(() => flattenExplorerSections(sections), [sections]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  // The scroll container holds every database section, so the virtual rows
  // region starts part-way down it; TanStack needs that offset (scrollMargin)
  // and it changes whenever other sections expand/collapse.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const scroller = getScrollElement();
    if (!container || !scroller) return;
    const offset = container.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    setScrollMargin((previous) => (Math.abs(previous - offset) > 1 ? offset : previous));
  }, [flatItems, getScrollElement, layoutKey]);

  // TanStack Virtual's API returns functions that cannot be memoized without
  // stale UI (react-compiler rule); the hook contract handles identity itself.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => getScrollElement(),
    estimateSize: (index) => estimateExplorerItemSize(flatItems[index]),
    overscan: 10,
    scrollMargin,
    getItemKey: (index) => flatItems[index].key,
  });

  const renderItem = useCallback((item: ExplorerFlatItem) => {
    switch (item.kind) {
      case "schema-head": {
        const groupState = getSchemaGroupFilterState(item.schemaName, mixedStateFilter);
        return (
          <div className="explorer-schema-head explorer-virtual-schema-head">
            <MixedCheckbox
              state={groupState}
              onChange={(next) => {
                for (const table of item.tables) {
                  onMixedStateToggle(item.schemaName, table.name, next);
                }
              }}
              title={`Schema filter: ${item.schemaName}`}
            />
            <span className="explorer-schema-name">{item.schemaName}</span>
            <span className="explorer-schema-count">{item.count}</span>
          </div>
        );
      }
      case "group-head":
        return (
          <div className="explorer-object-group-head explorer-virtual-group-head">
            {t(EXPLORER_GROUP_LABEL_KEYS[item.group] as import("../../../i18n").TranslationKey)}
          </div>
        );
      case "table": {
        const tableFilter = getMixedStateFilterForTable(item.table.name, item.schemaName);
        const itemState = getItemFilterState(item.table.name, item.schemaName, tableFilter);
        const isContextActive =
          contextQualifiedName !== null &&
          contextQualifiedName === getQualifiedTableName(item.table);
        return (
          <TableRow
            table={item.table}
            itemState={itemState}
            isContextActive={isContextActive}
            onTableClick={onTableClick}
            onTableDoubleClick={onTableDoubleClick}
            onStructureClick={onStructureClick}
            onTableContextMenu={onTableContextMenu}
            schemaName={item.schemaName}
            language={language}
            t={t}
            onMixedStateToggle={onMixedStateToggle}
          />
        );
      }
      case "view": {
        const tableFilter = getMixedStateFilterForTable(item.view.name, item.schemaName);
        const itemState = getItemFilterState(item.view.name, item.schemaName, tableFilter);
        return (
          <ViewRow
            view={item.view}
            itemState={itemState}
            onTableClick={onTableClick}
            onTableDoubleClick={onTableDoubleClick}
            onStructureClick={onStructureClick}
            schemaName={item.schemaName}
            language={language}
            t={t}
            onMixedStateToggle={onMixedStateToggle}
          />
        );
      }
      case "object":
        return (
          <StaticObjectRow
            object={item.object}
            metaText={item.group === "triggers"
              ? item.object.related_table || t("explorer.triggersGroup")
              : item.object.object_type}
            icon={item.group === "triggers" ? "GitBranch" : "FileCode"}
            onObjectSqlClick={onObjectSqlClick}
            t={t}
          />
        );
      default:
        return null;
    }
  }, [contextQualifiedName, getMixedStateFilterForTable, language, mixedStateFilter, onMixedStateToggle, onObjectSqlClick, onStructureClick, onTableClick, onTableContextMenu, onTableDoubleClick, t]);

  return (
    <div
      ref={containerRef}
      className="explorer-virtual-container"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => (
        <div
          key={virtualItem.key}
          data-index={virtualItem.index}
          ref={virtualizer.measureElement}
          className="explorer-virtual-row"
          style={{ transform: `translateY(${virtualItem.start - virtualizer.options.scrollMargin}px)` }}
        >
          {renderItem(flatItems[virtualItem.index])}
        </div>
      ))}
    </div>
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
  const explorerScrollRef = useRef<HTMLDivElement | null>(null);
  // Layout above the virtual panel (expanded DB headers) shifts its offset
  // inside the scroll container; key the effect off that layout signature.
  const layoutKey = useMemo(
    () => `${currentDatabase ?? ""}|${[...expandedDbs].sort().join(",")}|${activeSchemaFilter}|${availableSchemaNames.length}`,
    [activeSchemaFilter, availableSchemaNames.length, currentDatabase, expandedDbs],
  );
  const getScrollElement = useCallback(() => explorerScrollRef.current, []);

  return (
    <div ref={explorerScrollRef} className="explorer-tree-scroll">
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
                  <VirtualizedSchemaRows
                    sections={filteredSchemaSections}
                    getScrollElement={getScrollElement}
                    layoutKey={layoutKey}
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
