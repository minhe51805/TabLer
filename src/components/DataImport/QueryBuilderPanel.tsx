import { useMemo, useState } from "react";
import { Plus, Play, Trash2, X, Table2 } from "lucide-react";
import { useI18n } from "../../i18n";
import {
  deleteBuilderDefinition,
  listBuilderDefinitions,
  saveBuilderDefinition,
  type BuilderDefinition,
} from "../../utils/builder-definitions-store";
import type { BuilderAggregateFn } from "../../utils/query-builder";
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
  const [aggregateDraft, setAggregateDraft] = useState<{ fn: BuilderAggregateFn; tableId: string; column: string; alias: string }>({
    fn: "COUNT", tableId: "", column: "*", alias: "",
  });
  const [groupByDraft, setGroupByDraft] = useState<{ tableId: string; column: string }>({ tableId: "", column: "" });
  const [havingDraft, setHavingDraft] = useState<{ aggregateId: string; operator: ">"; value: string }>({ aggregateId: "", operator: ">", value: "" });
  const [definitions, setDefinitions] = useState<BuilderDefinition[]>(() => listBuilderDefinitions());
  const [definitionName, setDefinitionName] = useState("");

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

  const addAggregate = () => {
    if (!aggregateDraft.tableId) return;
    setModel((current) => ({
      ...current,
      aggregates: [
        ...current.aggregates,
        {
          id: `a${current.aggregates.length + 1}`,
          fn: aggregateDraft.fn,
          tableId: aggregateDraft.tableId,
          column: aggregateDraft.column,
          alias: aggregateDraft.alias.trim() || undefined,
        },
      ],
    }));
  };

  const addGroupBy = () => {
    if (!groupByDraft.tableId || !groupByDraft.column) return;
    setModel((current) => ({
      ...current,
      groupBy: [...current.groupBy, { tableId: groupByDraft.tableId, column: groupByDraft.column }],
    }));
  };

  const addHaving = () => {
    if (!havingDraft.aggregateId || !havingDraft.value.trim()) return;
    setModel((current) => ({
      ...current,
      having: [...current.having, { id: `h${current.having.length + 1}`, aggregateId: havingDraft.aggregateId, operator: havingDraft.operator, value: havingDraft.value.trim() }],
    }));
  };

  const handleSaveDefinition = () => {
    if (!definitionName.trim()) return;
    saveBuilderDefinition(definitionName.trim(), model);
    setDefinitions(listBuilderDefinitions());
    setDefinitionName("");
    emitAppToast({ title: t("querybuilder.definitionSaved"), tone: "success" });
  };

  const handleLoadDefinition = (id: string) => {
    const definition = definitions.find((entry) => entry.id === id);
    if (!definition) return;
    setModel(definition.model);
    for (const table of definition.model.tables) {
      void ensureColumns(table.name);
    }
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

        {/* Aggregates + GROUP BY + HAVING */}
        {model.tables.length > 0 && (
          <div className="qs-list schema-diff-results">
            <div className="qs-item static global-search-match-kind">{t("querybuilder.aggregates")}</div>
            {model.aggregates.map((aggregate) => {
              const table = model.tables.find((entry) => entry.id === aggregate.tableId);
              return (
                <div key={aggregate.id} className="qs-item static">
                  <span className="global-search-match-label">
                    {aggregate.fn}({aggregate.column === "*" ? "*" : `${table?.alias}.${aggregate.column}`})
                    {aggregate.alias ? ` AS ${aggregate.alias}` : ""}
                  </span>
                  <button
                    type="button"
                    className="qs-clear-btn"
                    aria-label="Remove aggregate"
                    onClick={() =>
                      setModel((current) => ({
                        ...current,
                        aggregates: current.aggregates.filter((entry) => entry.id !== aggregate.id),
                        having: current.having.filter((condition) => condition.aggregateId !== aggregate.id),
                      }))
                    }
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
            {model.groupBy.map((group) => {
              const table = model.tables.find((entry) => entry.id === group.tableId);
              return (
                <div key={`g-${group.tableId}-${group.column}`} className="qs-item static">
                  <span className="global-search-match-label">GROUP BY {table?.alias}.{group.column}</span>
                  <button
                    type="button"
                    className="qs-clear-btn"
                    aria-label="Remove group by"
                    onClick={() =>
                      setModel((current) => ({
                        ...current,
                        groupBy: current.groupBy.filter((entry) => !(entry.tableId === group.tableId && entry.column === group.column)),
                      }))
                    }
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
            {model.having.map((condition) => {
              const aggregate = model.aggregates.find((entry) => entry.id === condition.aggregateId);
              return (
                <div key={condition.id} className="qs-item static">
                  <span className="global-search-match-label">
                    HAVING {aggregate?.fn ?? "?"} {condition.operator} {condition.value}
                  </span>
                  <button
                    type="button"
                    className="qs-clear-btn"
                    aria-label="Remove having"
                    onClick={() =>
                      setModel((current) => ({
                        ...current,
                        having: current.having.filter((entry) => entry.id !== condition.id),
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
                value={aggregateDraft.fn}
                aria-label="Aggregate function"
                onChange={(event) => setAggregateDraft((current) => ({ ...current, fn: event.target.value as BuilderAggregateFn, column: event.target.value === "COUNT" || event.target.value === "COUNT_DISTINCT" ? "*" : current.column }))}
              >
                {(["COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX"] as BuilderAggregateFn[]).map((fn) => (
                  <option key={fn} value={fn}>{fn === "COUNT_DISTINCT" ? "COUNT DISTINCT" : fn}</option>
                ))}
              </select>
              <select
                value={aggregateDraft.tableId}
                aria-label="Aggregate table"
                onChange={(event) => {
                  const tableId = event.target.value;
                  setAggregateDraft((current) => ({ ...current, tableId, column: "" }));
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
                value={aggregateDraft.column}
                aria-label="Aggregate column"
                onChange={(event) => setAggregateDraft((current) => ({ ...current, column: event.target.value }))}
              >
                {(aggregateDraft.fn === "COUNT" || aggregateDraft.fn === "COUNT_DISTINCT") && (
                  <option value="*">* ({t("querybuilder.allRows")})</option>
                )}
                {(columnsByTable[model.tables.find((entry) => entry.id === aggregateDraft.tableId)?.name ?? ""] ?? []).map((column) => (
                  <option key={column} value={column}>{column}</option>
                ))}
              </select>
              <input
                value={aggregateDraft.alias}
                placeholder={t("querybuilder.alias")}
                aria-label="Aggregate alias"
                onChange={(event) => setAggregateDraft((current) => ({ ...current, alias: event.target.value }))}
              />
              <button type="button" className="global-search-mode" onClick={addAggregate}>
                <Plus size={12} /> {t("querybuilder.addAggregate")}
              </button>
            </div>
            <div className="qs-item static" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              <select
                value={groupByDraft.tableId}
                aria-label="Group by table"
                onChange={(event) => {
                  const tableId = event.target.value;
                  setGroupByDraft((current) => ({ ...current, tableId, column: "" }));
                  const table = model.tables.find((entry) => entry.id === tableId);
                  if (table) void ensureColumns(table.name);
                }}
              >
                <option value="">{t("querybuilder.groupBy")}</option>
                {model.tables.map((table) => (
                  <option key={table.id} value={table.id}>{table.alias}</option>
                ))}
              </select>
              <select
                value={groupByDraft.column}
                aria-label="Group by column"
                onChange={(event) => setGroupByDraft((current) => ({ ...current, column: event.target.value }))}
              >
                <option value="">{t("querybuilder.column")}</option>
                {(columnsByTable[model.tables.find((entry) => entry.id === groupByDraft.tableId)?.name ?? ""] ?? []).map((column) => (
                  <option key={column} value={column}>{column}</option>
                ))}
              </select>
              <select
                value={groupByDraft.tableId ? groupByDraft.column : ""}
                disabled={!groupByDraft.tableId || !groupByDraft.column}
                aria-label="Add group by"
                onChange={addGroupBy}
              >
                <option value="">+ {t("querybuilder.addGroupBy")}</option>
              </select>
              <button
                type="button"
                className="global-search-mode"
                disabled={!groupByDraft.tableId || !groupByDraft.column}
                onClick={addGroupBy}
              >
                <Plus size={12} /> {t("querybuilder.addGroupBy")}
              </button>
            </div>
            {model.aggregates.length > 0 && (
              <div className="qs-item static" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                <select
                  value={havingDraft.aggregateId}
                  aria-label="Having aggregate"
                  onChange={(event) => setHavingDraft((current) => ({ ...current, aggregateId: event.target.value }))}
                >
                  <option value="">{t("querybuilder.having")}</option>
                  {model.aggregates.map((aggregate) => (
                    <option key={aggregate.id} value={aggregate.id}>{aggregate.alias || aggregate.fn}</option>
                  ))}
                </select>
                <div style={{ display: "flex", gap: 4 }}>
                  <select
                    value={havingDraft.operator}
                    aria-label="Having operator"
                    onChange={(event) => setHavingDraft((current) => ({ ...current, operator: event.target.value as ">" }))}
                  >
                    {[">", ">=", "<", "<=", "=", "!="].map((operator) => (
                      <option key={operator} value={operator}>{operator}</option>
                    ))}
                  </select>
                  <input
                    value={havingDraft.value}
                    placeholder="100"
                    aria-label="Having value"
                    onChange={(event) => setHavingDraft((current) => ({ ...current, value: event.target.value }))}
                  />
                  <button type="button" className="global-search-mode" onClick={addHaving}>
                    <Plus size={12} />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Saved definitions */}
        <div className="qs-list schema-diff-results">
          <div className="qs-item static global-search-match-kind">{t("querybuilder.definitions")}</div>
          <div className="qs-item static" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 4 }}>
            <input
              value={definitionName}
              placeholder={t("querybuilder.definitionName")}
              aria-label="Definition name"
              onChange={(event) => setDefinitionName(event.target.value)}
            />
            <button
              type="button"
              className="global-search-mode"
              disabled={!definitionName.trim() || model.tables.length === 0}
              onClick={handleSaveDefinition}
            >
              {t("querybuilder.saveDefinition")}
            </button>
          </div>
          {definitions.map((definition) => (
            <div key={definition.id} className="qs-item static">
              <span className="global-search-match-label">{definition.name}</span>
              <span style={{ display: "flex", gap: 4 }}>
                <button type="button" className="fav-action-btn" title={t("querybuilder.loadDefinition")} onClick={() => handleLoadDefinition(definition.id)}>
                  <Play size={12} />
                </button>
                <button
                  type="button"
                  className="fav-action-btn danger"
                  title={t("querybuilder.deleteDefinition")}
                  onClick={() => {
                    deleteBuilderDefinition(definition.id);
                    setDefinitions(listBuilderDefinitions());
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </span>
            </div>
          ))}
        </div>

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
