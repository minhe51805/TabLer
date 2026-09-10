import { useMemo, useState } from "react";
import { Plus, Play, Trash2, X, Table2 } from "lucide-react";
import { useI18n } from "../../i18n";
import { emitAppToast } from "../../utils/app-toast";
import {
  buildSelectSql,
  createEmptyBuilderModel,
  type BuilderJoinKind,
  type QueryBuilderModel,
} from "../../utils/query-builder";
import type { TableInfo, ColumnDetail, DatabaseType } from "../../types";

interface QueryBuilderPanelProps {
  tables: TableInfo[];
  dbType: DatabaseType | undefined;
  /** Loads columns for a table (cached store loader). */
  loadColumns: (tableName: string) => Promise<ColumnDetail[]>;
  /** Sends the compiled SQL to a new query tab. */
  onOpenInQueryTab: (sql: string) => void;
  onClose: () => void;
}

const JOIN_KINDS: BuilderJoinKind[] = ["inner", "left", "right", "full", "cross"];

/**
 * Visual SELECT builder (Phase 1-2): pick tables, define joins and filters,
 * watch the SQL compile live, then open it in a query tab. The generated
 * statement is always user-editable text — the builder is a front door,
 * not a cage.
 */
export function QueryBuilderPanel({ tables, dbType, loadColumns, onOpenInQueryTab, onClose }: QueryBuilderPanelProps) {
  const { t } = useI18n();
  const [model, setModel] = useState<QueryBuilderModel>(createEmptyBuilderModel);
  const [columnsByTable, setColumnsByTable] = useState<Record<string, string[]>>({});
  const [joinDraft, setJoinDraft] = useState<{ left: string; leftColumn: string; right: string; rightColumn: string; kind: BuilderJoinKind }>({
    left: "", leftColumn: "", right: "", rightColumn: "", kind: "inner",
  });
  const [filterDraft, setFilterDraft] = useState<{ tableId: string; column: string; operator: "=" | "LIKE"; value: string }>({
    tableId: "", column: "", operator: "=", value: "",
  });

  const ensureColumns = async (tableName: string) => {
    if (columnsByTable[tableName]) return;
    try {
      const columns = await loadColumns(tableName);
      setColumnsByTable((current) => ({ ...current, [tableName]: columns.map((column) => column.name) }));
    } catch {
      setColumnsByTable((current) => ({ ...current, [tableName]: [] }));
    }
  };

  const sql = useMemo(() => {
    try {
      return buildSelectSql(model, dbType);
    } catch (error) {
      return `-- ${error instanceof Error ? error.message : String(error)}`;
    }
  }, [model, dbType]);

  const addTable = async (tableName: string) => {
    if (!tableName || model.tables.some((table) => table.name === tableName)) return;
    const id = `t${model.tables.length + 1}_${tableName.replace(/\W/g, "_")}`;
    setModel((current) => ({
      ...current,
      tables: [...current.tables, { id, name: tableName, alias: tableName.replace(/\W/g, "_").toLowerCase() }],
    }));
    await ensureColumns(tableName);
  };

  const addJoin = () => {
    if (!joinDraft.left || !joinDraft.right || !joinDraft.leftColumn || !joinDraft.rightColumn) return;
    setModel((current) => ({
      ...current,
      joins: [
        ...current.joins,
        {
          id: `j${current.joins.length + 1}`,
          kind: joinDraft.kind,
          leftTableId: joinDraft.left,
          leftColumn: joinDraft.leftColumn,
          rightTableId: joinDraft.right,
          rightColumn: joinDraft.rightColumn,
        },
      ],
    }));
  };

  const addFilter = () => {
    if (!filterDraft.tableId || !filterDraft.column) return;
    setModel((current) => ({
      ...current,
      filters: [
        ...current.filters,
        {
          id: `f${current.filters.length + 1}`,
          tableId: filterDraft.tableId,
          column: filterDraft.column,
          operator: filterDraft.operator,
          value: filterDraft.value,
        },
      ],
    }));
  };

  const handleOpen = () => {
    try {
      const compiled = buildSelectSql(model, dbType);
      onOpenInQueryTab(compiled);
      onClose();
    } catch (error) {
      emitAppToast({
        title: t("querybuilder.cannotBuild"),
        description: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    }
  };

  return (
    <div className="qs-overlay" role="presentation" onClick={onClose}>
      <div
        className="qs-panel data-import-panel"
        role="dialog"
        aria-label={t("querybuilder.title")}
        onClick={(event) => event.stopPropagation()}
        style={{ maxWidth: 720, maxHeight: "85vh", overflowY: "auto" }}
      >
        <div className="qs-input-row">
          <strong><Table2 size={14} className="inline-block mr-1" /> {t("querybuilder.title")}</strong>
          <button type="button" className="qs-clear-btn" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* Tables */}
        <div className="qs-list schema-diff-results">
          <div className="qs-item static global-search-match-kind">{t("querybuilder.tables")}</div>
          {model.tables.map((table) => (
            <div key={table.id} className="qs-item static">
              <span className="global-search-match-label">{table.name} AS {table.alias}</span>
              <button
                type="button"
                className="qs-clear-btn"
                aria-label={`Remove ${table.name}`}
                onClick={() =>
                  setModel((current) => ({
                    ...current,
                    tables: current.tables.filter((entry) => entry.id !== table.id),
                    joins: current.joins.filter((join) => join.leftTableId !== table.id && join.rightTableId !== table.id),
                    filters: current.filters.filter((filter) => filter.tableId !== table.id),
                    orders: current.orders.filter((order) => order.tableId !== table.id),
                    selects: current.selects.filter((select) => select.tableId !== table.id),
                  }))
                }
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <div className="qs-item static">
            <select
              value=""
              aria-label={t("querybuilder.addTable")}
              onChange={(event) => void addTable(event.target.value)}
            >
              <option value="">+ {t("querybuilder.addTable")}</option>
              {tables.filter((table) => !model.tables.some((entry) => entry.name === table.name)).map((table) => (
                <option key={table.name} value={table.name}>{table.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Joins */}
        {model.tables.length >= 2 && (
          <div className="qs-list schema-diff-results">
            <div className="qs-item static global-search-match-kind">{t("querybuilder.joins")}</div>
            {model.joins.map((join) => {
              const left = model.tables.find((table) => table.id === join.leftTableId);
              const right = model.tables.find((table) => table.id === join.rightTableId);
              return (
                <div key={join.id} className="qs-item static">
                  <span className="global-search-match-label">
                    {left?.alias}.{join.leftColumn} = {right?.alias}.{join.rightColumn} ({join.kind})
                  </span>
                  <button
                    type="button"
                    className="qs-clear-btn"
                    aria-label="Remove join"
                    onClick={() =>
                      setModel((current) => ({
                        ...current,
                        joins: current.joins.filter((entry) => entry.id !== join.id),
                      }))
                    }
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
            <div className="qs-item static" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              <select
                value={joinDraft.left}
                aria-label="Join left table"
                onChange={(event) => {
                  const tableId = event.target.value;
                  setJoinDraft((current) => ({ ...current, left: tableId, leftColumn: "" }));
                  const table = model.tables.find((entry) => entry.id === tableId);
                  if (table) void ensureColumns(table.name);
                }}
              >
                <option value="">{t("querybuilder.leftTable")}</option>
                {model.tables.map((table) => (
                  <option key={table.id} value={table.id}>{table.alias}</option>
                ))}
              </select>
              <select
                value={joinDraft.leftColumn}
                aria-label="Join left column"
                onChange={(event) => setJoinDraft((current) => ({ ...current, leftColumn: event.target.value }))}
              >
                <option value="">{t("querybuilder.column")}</option>
                {(columnsByTable[model.tables.find((entry) => entry.id === joinDraft.left)?.name ?? ""] ?? []).map((column) => (
                  <option key={column} value={column}>{column}</option>
                ))}
              </select>
              <select
                value={joinDraft.right}
                aria-label="Join right table"
                onChange={(event) => {
                  const tableId = event.target.value;
                  setJoinDraft((current) => ({ ...current, right: tableId, rightColumn: "" }));
                  const table = model.tables.find((entry) => entry.id === tableId);
                  if (table) void ensureColumns(table.name);
                }}
              >
                <option value="">{t("querybuilder.rightTable")}</option>
                {model.tables.map((table) => (
                  <option key={table.id} value={table.id}>{table.alias}</option>
                ))}
              </select>
              <select
                value={joinDraft.rightColumn}
                aria-label="Join right column"
                onChange={(event) => setJoinDraft((current) => ({ ...current, rightColumn: event.target.value }))}
              >
                <option value="">{t("querybuilder.column")}</option>
                {(columnsByTable[model.tables.find((entry) => entry.id === joinDraft.right)?.name ?? ""] ?? []).map((column) => (
                  <option key={column} value={column}>{column}</option>
                ))}
              </select>
              <select
                value={joinDraft.kind}
                aria-label="Join kind"
                onChange={(event) => setJoinDraft((current) => ({ ...current, kind: event.target.value as BuilderJoinKind }))}
              >
                {JOIN_KINDS.map((kind) => (
                  <option key={kind} value={kind}>{kind.toUpperCase()}</option>
                ))}
              </select>
              <button type="button" className="global-search-mode" onClick={addJoin}>
                <Plus size={12} /> {t("querybuilder.addJoin")}
              </button>
            </div>
          </div>
        )}

        {/* Filters */}
        {model.tables.length > 0 && (
          <div className="qs-list schema-diff-results">
            <div className="qs-item static global-search-match-kind">{t("querybuilder.filters")}</div>
            {model.filters.map((filter) => {
              const table = model.tables.find((entry) => entry.id === filter.tableId);
              return (
                <div key={filter.id} className="qs-item static">
                  <span className="global-search-match-label">
                    {table?.alias}.{filter.column} {filter.operator} {filter.operator.includes("NULL") ? "" : filter.value}
                  </span>
                  <button
                    type="button"
                    className="qs-clear-btn"
                    aria-label="Remove filter"
                    onClick={() =>
                      setModel((current) => ({
                        ...current,
                        filters: current.filters.filter((entry) => entry.id !== filter.id),
                      }))
                    }
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
            <div className="qs-item static" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              <select
                value={filterDraft.tableId}
                aria-label="Filter table"
                onChange={(event) => {
                  const tableId = event.target.value;
                  setFilterDraft((current) => ({ ...current, tableId, column: "" }));
                  const table = model.tables.find((entry) => entry.id === tableId);
                  if (table) void ensureColumns(table.name);
                }}
              >
                <option value="">{t("querybuilder.leftTable")}</option>
                {model.tables.map((table) => (
                  <option key={table.id} value={table.id}>{table.alias}</option>
                ))}
              </select>
              <select
                value={filterDraft.column}
                aria-label="Filter column"
                onChange={(event) => setFilterDraft((current) => ({ ...current, column: event.target.value }))}
              >
                <option value="">{t("querybuilder.column")}</option>
                {(columnsByTable[model.tables.find((entry) => entry.id === filterDraft.tableId)?.name ?? ""] ?? []).map((column) => (
                  <option key={column} value={column}>{column}</option>
                ))}
              </select>
              <select
                value={filterDraft.operator}
                aria-label="Filter operator"
                onChange={(event) => setFilterDraft((current) => ({ ...current, operator: event.target.value as "=" | "LIKE" }))}
              >
                <option value="=">=</option>
                <option value="LIKE">LIKE</option>
              </select>
              <input
                value={filterDraft.value}
                placeholder={t("querybuilder.value")}
                aria-label="Filter value"
                onChange={(event) => setFilterDraft((current) => ({ ...current, value: event.target.value }))}
              />
              <button type="button" className="global-search-mode" onClick={addFilter}>
                <Plus size={12} /> {t("querybuilder.addFilter")}
              </button>
            </div>
          </div>
        )}

        {/* Live SQL preview + action */}
        <pre
          className="explain-raw-output"
          style={{ margin: "8px 0", maxHeight: 160, overflow: "auto", fontSize: 11 }}
          aria-label={t("querybuilder.preview")}
        >
          {sql}
        </pre>
        <div className="schema-diff-selects">
          <button
            type="button"
            className="global-search-mode active"
            disabled={model.tables.length === 0}
            onClick={handleOpen}
          >
            <Play size={13} /> {t("querybuilder.openInTab")}
          </button>
        </div>
      </div>
    </div>
  );
}
