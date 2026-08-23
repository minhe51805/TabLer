import { memo, useCallback } from "react";
import { Columns, Eye, FileCode, GitBranch, Table } from "lucide-react";
import type { SchemaObjectInfo, TableInfo } from "../../../types";
import { formatCountLabel } from "../../../i18n";
import type { AppLanguage, TranslationKey } from "../../../i18n";
import type { ExplorerSchemaSection } from "../hooks/useTreeState";
import type { CheckboxFilterState } from "../hooks/use-sidebar";

export type SectionTable = ExplorerSchemaSection["tables"][number];
export type SectionView = ExplorerSchemaSection["views"][number];

type TranslateFn = (key: TranslationKey, opts?: Record<string, string | number>) => string;

interface RowSharedProps {
  schemaName: string;
  language: AppLanguage;
  t: TranslateFn;
  onMixedStateToggle: (schemaName: string, itemName: string, nextState: CheckboxFilterState) => void;
}

// ---------------------------------------------------------------------------
// Mixed-state checkbox SVG icon
// ---------------------------------------------------------------------------

export const MixedCheckbox = memo(function MixedCheckbox({ state, onChange, title }: {
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
});

function useItemFilterToggle(
  onMixedStateToggle: RowSharedProps["onMixedStateToggle"],
  schemaName: string,
  itemName: string,
) {
  return useCallback(
    (next: CheckboxFilterState) => onMixedStateToggle(schemaName, itemName, next),
    [onMixedStateToggle, schemaName, itemName],
  );
}

// ---------------------------------------------------------------------------
// Memoized object rows
// ---------------------------------------------------------------------------

export const TableRow = memo(function TableRow({
  table,
  itemState,
  isContextActive,
  onTableClick,
  onTableDoubleClick,
  onStructureClick,
  onTableContextMenu,
  ...shared
}: {
  table: SectionTable;
  itemState: CheckboxFilterState;
  isContextActive: boolean;
  onTableClick: (table: Pick<TableInfo, "name" | "schema">) => void;
  onTableDoubleClick?: (table: Pick<TableInfo, "name" | "schema">) => void;
  onStructureClick: (e: React.MouseEvent, table: Pick<TableInfo, "name" | "schema">) => void;
  onTableContextMenu: (event: React.MouseEvent, table: Pick<TableInfo, "name" | "schema" | "row_count">) => void;
} & RowSharedProps) {
  const { schemaName, language, t } = shared;
  const handleFilterChange = useItemFilterToggle(shared.onMixedStateToggle, schemaName, table.name);

  return (
    <div
      className={`explorer-table-row ${isContextActive ? "context-active" : ""}`}
      onContextMenu={(event) => onTableContextMenu(event, table)}
    >
      {/* Mixed-state checkbox */}
      <MixedCheckbox
        state={itemState}
        onChange={handleFilterChange}
        title={`Table filter: ${itemState} — checked=include, unchecked=exclude, indeterminate=no filter`}
      />
      <button
        data-testid={`table-${schemaName}-${table.name}`}
        onClick={() => onTableClick(table)}
        onDoubleClick={(e) => { e.stopPropagation(); onTableDoubleClick?.(table); }}
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
        className="explorer-structure-btn explorer-structure-btn--icon"
        title={t("explorer.viewStructure")}
        aria-label={t("explorer.viewStructure")}
      >
        <Columns className="w-3.5 h-3.5" />
      </button>
    </div>
  );
});

export const ViewRow = memo(function ViewRow({
  view,
  itemState,
  onTableClick,
  onTableDoubleClick,
  onStructureClick,
  ...shared
}: {
  view: SectionView;
  itemState: CheckboxFilterState;
  onTableClick: (table: Pick<TableInfo, "name" | "schema">) => void;
  onTableDoubleClick?: (table: Pick<TableInfo, "name" | "schema">) => void;
  onStructureClick: (e: React.MouseEvent, table: Pick<TableInfo, "name" | "schema">) => void;
} & RowSharedProps) {
  const { schemaName, t } = shared;
  const handleFilterChange = useItemFilterToggle(shared.onMixedStateToggle, schemaName, view.name);

  return (
    <div className="explorer-table-row">
      <MixedCheckbox
        state={itemState}
        onChange={handleFilterChange}
        title={`View filter: ${itemState}`}
      />
      <button
        onClick={() => onTableClick({ name: view.name, schema: view.schema })}
        onDoubleClick={(e) => { e.stopPropagation(); onTableDoubleClick?.({ name: view.name, schema: view.schema }); }}
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
        className="explorer-structure-btn explorer-structure-btn--icon"
        title={t("explorer.viewStructure")}
        aria-label={t("explorer.viewStructure")}
      >
        <Columns className="w-3.5 h-3.5" />
      </button>
    </div>
  );
});

export const StaticObjectRow = memo(function StaticObjectRow({
  object,
  metaText,
  icon,
  onObjectSqlClick,
  t,
}: {
  object: SchemaObjectInfo;
  metaText: string;
  icon: "GitBranch" | "FileCode";
  onObjectSqlClick: (e: React.MouseEvent, object: SchemaObjectInfo) => void;
  t: TranslateFn;
}) {
  const IconGlyph = icon === "GitBranch" ? GitBranch : FileCode;
  return (
    <div className="explorer-table-row explorer-object-row">
      <div className="explorer-table-main static">
        <div className="explorer-table-icon">
          <IconGlyph className="w-3.5 h-3.5 shrink-0" />
        </div>
        <div className="explorer-table-copy">
          <span className="explorer-table-name">{object.name}</span>
          <span className="explorer-table-meta">{metaText}</span>
        </div>
      </div>
      <button
        onClick={(e) => onObjectSqlClick(e, object)}
        className="explorer-structure-btn"
        title={`${t("common.open")} SQL`}
      >
        <FileCode className="w-3.5 h-3.5" />
        <span>SQL</span>
      </button>
    </div>
  );
});
