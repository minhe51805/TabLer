/**
 * Visual Query Builder — model + SQL emitter (Group-2 Feature 5, Phase 1-2).
 *
 * Pure: a builder definition (tables, joins, filters, ordering, projection)
 * in → a dialect-quoted SELECT out. Identifier quoting mirrors the row-SQL
 * generator; values are always single-quoted literals.
 */

import type { DatabaseType } from "../types/database";

export interface BuilderTable {
  /** Stable node id (also the default alias). */
  id: string;
  name: string;
  alias: string;
}

export type BuilderJoinKind = "inner" | "left" | "right" | "full" | "cross";

export interface BuilderJoin {
  id: string;
  kind: BuilderJoinKind;
  leftTableId: string;
  leftColumn: string;
  rightTableId: string;
  rightColumn: string;
}

export interface BuilderFilter {
  id: string;
  tableId: string;
  column: string;
  operator: "=" | "!=" | "<" | ">" | "<=" | ">=" | "LIKE" | "IN" | "IS NULL" | "IS NOT NULL";
  /** Raw literal text; empty for the NULL checks. */
  value: string;
}

export interface BuilderOrder {
  id: string;
  tableId: string;
  column: string;
  direction: "ASC" | "DESC";
}

export interface BuilderSelect {
  tableId: string;
  column: string;
}

export interface QueryBuilderModel {
  tables: BuilderTable[];
  joins: BuilderJoin[];
  filters: BuilderFilter[];
  orders: BuilderOrder[];
  selects: BuilderSelect[];
  distinct: boolean;
  limit: number | null;
}

export function createEmptyBuilderModel(): QueryBuilderModel {
  return { tables: [], joins: [], filters: [], orders: [], selects: [], distinct: false, limit: null };
}

type QuoteFn = (name: string) => string;

function quotePostgres(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
function quoteBacktick(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}
function quoteMssql(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

function getQuoteFn(dbType: DatabaseType | undefined): QuoteFn {
  switch (dbType) {
    case "mysql":
    case "mariadb":
    case "clickhouse":
      return quoteBacktick;
    case "mssql":
      return quoteMssql;
    default:
      return quotePostgres;
  }
}

function aliasFor(table: BuilderTable): string {
  return table.alias || table.id;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Compile the model into a SELECT statement. Throws when the model is not yet runnable. */
export function buildSelectSql(model: QueryBuilderModel, dbType: DatabaseType | undefined): string {
  if (model.tables.length === 0) {
    throw new Error("Add at least one table to build a query.");
  }
  const quote = getQuoteFn(dbType);
  const aliasById = new Map(model.tables.map((table) => [table.id, aliasFor(table)]));
  const qualified = (tableId: string, column: string): string => {
    const alias = aliasById.get(tableId);
    if (!alias) throw new Error(`Unknown table reference: ${tableId}`);
    return `${quote(alias)}.${quote(column)}`;
  };

  const lines: string[] = [];
  const projection = model.selects.length > 0
    ? model.selects.map((select) => qualified(select.tableId, select.column))
    : model.tables.map((table) => `${quote(aliasFor(table))}.*`);

  lines.push(`SELECT ${model.distinct ? "DISTINCT " : ""}${projection.join(", ")}`);

  const primary = model.tables[0];
  lines.push(`FROM ${quote(primary.name)} AS ${quote(aliasFor(primary))}`);

  const joined = new Set<string>([primary.id]);
  for (const join of model.joins) {
    const rightTable = model.tables.find((table) => table.id === join.rightTableId);
    if (!rightTable) continue;
    const keyword = join.kind === "cross" ? "CROSS JOIN" : `${join.kind.toUpperCase()} JOIN`;
    lines.push(
      `${keyword} ${quote(rightTable.name)} AS ${quote(aliasFor(rightTable))}`
        + (join.kind === "cross"
          ? ""
          : ` ON ${qualified(join.leftTableId, join.leftColumn)} = ${qualified(join.rightTableId, join.rightColumn)}`),
    );
    joined.add(join.rightTableId);
  }

  const whereParts = model.filters.map((filter) => {
    const target = qualified(filter.tableId, filter.column);
    switch (filter.operator) {
      case "IS NULL":
        return `${target} IS NULL`;
      case "IS NOT NULL":
        return `${target} IS NOT NULL`;
      case "IN":
        return `${target} IN (${filter.value.split(",").map((part) => literal(part.trim())).join(", ")})`;
      default:
        return `${target} ${filter.operator} ${literal(filter.value)}`;
    }
  }).filter(Boolean);
  if (whereParts.length > 0) {
    lines.push(`WHERE ${whereParts.join("\n  AND ")}`);
  }

  if (model.orders.length > 0) {
    lines.push(`ORDER BY ${model.orders.map((order) => `${qualified(order.tableId, order.column)} ${order.direction}`).join(", ")}`);
  }

  if (model.limit !== null && model.limit > 0) {
    lines.push(`LIMIT ${Math.floor(model.limit)}`);
  }

  return `${lines.join("\n")};`;
}
