import type { ColumnDetail, QueryResult, RowKeyValue } from "../../../types";
import type { DatabaseType } from "../../../types/database";
import { buildQualifiedObjectIdentity } from "../../../utils/database-object-identity";

// ─── Cache types ───────────────────────────────────────────────────────────────

interface CachedTablePage {
  result: QueryResult;
  totalRows: number;
  cachedAt: number;
}

// ─── Cache constants ───────────────────────────────────────────────────────────

const PAGE_SIZE = 100;

// ─── Module-level caches ───────────────────────────────────────────────────────

const tablePageCache = new Map<string, CachedTablePage>();
const tableCountCache = new Map<string, { totalRows: number; cachedAt: number }>();

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ResolvedColumn = ColumnDetail & { column_type?: string };
export type GridCellValue = string | number | boolean | null;
export type StructureStatus = "idle" | "loading" | "ready" | "failed";
export type EditingCell = { row: number; col: number };

export { PAGE_SIZE };

// ─── Cache helpers ─────────────────────────────────────────────────────────────

export function buildTableScopeKey(connectionId: string, tableName: string, database?: string) {
  const identity = buildQualifiedObjectIdentity(connectionId, tableName, database);
  return JSON.stringify({
    connectionId: identity.connectionId,
    database: identity.database ?? "",
    schema: identity.schema ?? "",
    object: identity.object,
  });
}

export function buildTableCacheKey(
  connectionId: string,
  tableName: string,
  database?: string,
  page?: number,
  sortColumn?: string | null,
  sortDir?: "ASC" | "DESC",
  filter?: string,
  quickFilter?: string,
) {
  const identity = buildQualifiedObjectIdentity(connectionId, tableName, database);
  return JSON.stringify({
    connectionId: identity.connectionId,
    database: identity.database ?? "",
    schema: identity.schema ?? "",
    object: identity.object,
    page: page ?? 0,
    sortColumn: sortColumn || "",
    sortDir: sortDir || "",
    filter: filter || "",
    quickFilter: quickFilter || "",
  });
}

export function isFreshCacheEntry(cachedAt: number, ttlMs: number) {
  return Date.now() - cachedAt <= ttlMs;
}

export function setBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number) {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);

  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

export function matchesCacheScope(
  key: string,
  connectionId: string,
  database?: string,
  tableName?: string,
) {
  let parsed: {
    connectionId?: string;
    database?: string;
    schema?: string;
    object?: string;
  };
  try {
    parsed = JSON.parse(key) as typeof parsed;
  } catch {
    return false;
  }
  if (parsed.connectionId !== connectionId) return false;
  if (database !== undefined && (parsed.database || "") !== (database || "")) return false;
  if (tableName !== undefined) {
    const requested = buildQualifiedObjectIdentity(connectionId, tableName, database);
    if ((parsed.schema || "") !== (requested.schema ?? "")) return false;
    if (parsed.object !== requested.object) return false;
  }
  return true;
}

export function invalidateTableScopeCaches(
  connectionId: string,
  database?: string,
  tableName?: string,
  invalidateStructure = false,
) {
  for (const key of tableCountCache.keys()) {
    if (matchesCacheScope(key, connectionId, database, tableName)) {
      tableCountCache.delete(key);
    }
  }

  for (const key of tablePageCache.keys()) {
    if (matchesCacheScope(key, connectionId, database, tableName)) {
      tablePageCache.delete(key);
    }
  }

  if (invalidateStructure) {
    const { inlineStructureCache } = inlineStructureCacheRef;
    for (const key of inlineStructureCache.keys()) {
      if (matchesCacheScope(key, connectionId, database, tableName)) {
        inlineStructureCache.delete(key);
      }
    }
  }
}

export function clearAllTableCaches() {
  tableCountCache.clear();
  tablePageCache.clear();
}

export function invalidateTableCaches(
  connectionId: string,
  tableName: string,
  database?: string,
  options?: { invalidateStructure?: boolean },
) {
  invalidateTableScopeCaches(
    connectionId,
    database,
    tableName,
    Boolean(options?.invalidateStructure),
  );
}

export { tablePageCache, tableCountCache };

// ─── Column helpers ─────────────────────────────────────────────────────────────

export const inlineStructureCacheRef = { inlineStructureCache: new Map<string, ColumnDetail[]>() };

export function buildColumnSignature(
  columns: Array<{
    name: string;
    data_type?: string;
    column_type?: string;
    is_nullable?: boolean;
    is_primary_key?: boolean;
    default_value?: string;
    extra?: string;
  }>,
) {
  return columns
    .map((column) =>
      [
        column.name,
        column.column_type || column.data_type || "",
        column.is_nullable ? "nullable" : "required",
        column.is_primary_key ? "pk" : "col",
        column.default_value || "",
        column.extra || "",
      ].join(":"),
    )
    .join("|");
}

export function buildResolvedColumns(
  dataColumns: import("../../../types").ColumnInfo[],
  structureColumns: ColumnDetail[],
): ResolvedColumn[] {
  if (dataColumns.length === 0) return [];

  const structureByName = new Map(structureColumns.map((column) => [column.name, column]));
  return dataColumns.map((column) => {
    const structureColumn = structureByName.get(column.name);
    if (!structureColumn) return column;

    return {
      ...column,
      data_type: structureColumn.data_type || column.data_type,
      column_type: structureColumn.column_type,
      is_nullable: structureColumn.is_nullable,
      is_primary_key: structureColumn.is_primary_key,
      default_value: structureColumn.default_value,
    };
  });
}

// ─── Cell editing helpers ──────────────────────────────────────────────────────

export function isBooleanColumn(column: ResolvedColumn) {
  return /(bool)/i.test(column.column_type || column.data_type || "");
}

export function isNumericColumn(column: ResolvedColumn) {
  // Match exact base type names — substring matching pulls in PostgreSQL
  // types like "point" and "interval" that contain "int" but reject numbers.
  const raw = (column.column_type || column.data_type || "").toLowerCase().trim();
  const base = raw.replace(/\s*\(.*$/, "").trim();
  if (base === "double precision") return true;
  const head = base.split(/\s+/)[0] ?? "";
  return NUMERIC_TYPE_NAMES.has(base) || NUMERIC_TYPE_NAMES.has(head);
}

const NUMERIC_TYPE_NAMES = new Set([
  "int",
  "int2",
  "int4",
  "int8",
  "integer",
  "smallint",
  "bigint",
  "tinyint",
  "mediumint",
  "serial",
  "smallserial",
  "bigserial",
  "serial2",
  "serial4",
  "serial8",
  "numeric",
  "decimal",
  "dec",
  "fixed",
  "float",
  "float4",
  "float8",
  "double",
  "real",
  "money",
  "smallmoney",
  "number",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "int16",
  "int32",
  "int64",
  "int128",
  "int256",
  "uint128",
  "uint256",
]);

/** True when a column's type can be compared with LIKE — mirrors the
 *  backend `is_text_like_column` used by the data-search commands. */
export function isTextLikeColumn(column: {
  name: string;
  data_type?: string;
  column_type?: string;
}) {
  const normalized = (column.column_type || column.data_type || "").toLowerCase();
  return ["char", "text", "clob", "uuid", "citext", "name", "enum"].some((needle) =>
    normalized.includes(needle),
  );
}

/** Identifiers the backend filter grammar accepts (letters/digits/underscore,
 *  optionally dot-qualified). Columns with other names can't be quoted into a
 *  server-side filter clause. */
const FILTER_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * Compile the toolbar quick-filter text into a backend filter-clause
 * fragment (`col LIKE '%x%' OR ...`) over the table's text-like columns.
 * Returns null when the filter can't run server-side — the caller must then
 * keep client-side filtering and show the "loaded rows only" hint.
 *
 * NOTE: the backend grammar has no ESCAPE clause, so `%`/`_` typed by the
 * user act as LIKE wildcards server-side; the client-side re-filter narrows
 * the displayed rows back to literal matches.
 */
export function buildTableFilterClause(
  filter: string,
  columns: Array<{ name: string; data_type?: string; column_type?: string }>,
  dbType?: DatabaseType,
): string | null {
  const needle = filter.trim();
  if (!needle) return null;
  const likeOperator =
    dbType === "postgresql" ||
    dbType === "cockroachdb" ||
    dbType === "redshift" ||
    dbType === "greenplum"
      ? "ILIKE"
      : "LIKE";
  const pattern = `%${needle.replace(/'/g, "''")}%`;
  const conditions = columns
    .filter((column) => isTextLikeColumn(column) && FILTER_IDENTIFIER_RE.test(column.name))
    .map((column) => `${column.name} ${likeOperator} '${pattern}'`);
  return conditions.length > 0 ? conditions.join(" OR ") : null;
}

export interface TableFilterPlan {
  /** WHERE fragment sent to get_table_data / export_table_data ("" = none). */
  serverFilter: string;
  /** True when the quick filter can only run over already-loaded rows. */
  clientSideOnly: boolean;
}

/**
 * Decide how the toolbar quick filter executes. The backend grammar has no
 * parentheses, so a row-focus filter (already a clause) can't be AND-ed with
 * the quick filter's OR chain — in that case the focus filter stays
 * server-side and the quick filter degrades to loaded-rows-only.
 */
export function resolveTableFilter(
  tableFilter: string,
  rowFocusFilter: string,
  columns: Array<{ name: string; data_type?: string; column_type?: string }>,
  dbType?: DatabaseType,
): TableFilterPlan {
  const quick = tableFilter.trim();
  if (!quick) return { serverFilter: rowFocusFilter, clientSideOnly: false };
  if (rowFocusFilter) return { serverFilter: rowFocusFilter, clientSideOnly: true };
  const clause = buildTableFilterClause(quick, columns, dbType);
  return clause
    ? { serverFilter: clause, clientSideOnly: false }
    : { serverFilter: "", clientSideOnly: true };
}

export function isDateColumn(column: ResolvedColumn) {
  const type = (column.column_type || column.data_type || "").toLowerCase();
  return type === "date";
}

export function isDateTimeColumn(column: ResolvedColumn) {
  const type = (column.column_type || column.data_type || "").toLowerCase();
  return /^(datetime|timestamp|timewithtimezone|timetz)$/i.test(type);
}

export function isTimeColumn(column: ResolvedColumn) {
  const type = (column.column_type || column.data_type || "").toLowerCase();
  return (
    /^(time|time without time zone|timewithtimezone)$/i.test(type) && !isDateTimeColumn(column)
  );
}

export function isJSONColumn(column: ResolvedColumn) {
  const type = (column.column_type || column.data_type || "").toLowerCase();
  return /^(json|jsonb)/.test(type);
}

export function isBlobColumn(column: ResolvedColumn) {
  const type = (column.column_type || column.data_type || "").toLowerCase();
  return /^(bytea|blob|binary|varbinary|longblob|mediumblob|tinyblob|geometry)/i.test(type);
}

export function editorValueFromCell(value: GridCellValue) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function parseEditorValue(rawValue: string, column: ResolvedColumn): GridCellValue {
  const trimmed = rawValue.trim();

  // Typed text stays text: only the dedicated NULL gestures (select option,
  // clear-range, paste-empty) produce real NULL — they bypass this parser.

  if (isBooleanColumn(column)) {
    if (/^(true|t|1|yes)$/i.test(trimmed)) return true;
    if (/^(false|f|0|no)$/i.test(trimmed)) return false;
    throw new Error("Boolean values must be true or false.");
  }

  if (isNumericColumn(column)) {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
      throw new Error("Numeric columns only accept valid numbers.");
    }
    // Keep high-precision input as a string: Number() would silently round
    // bigint/decimal values beyond IEEE-754 precision.
    const significantDigits = trimmed.replace(/[^0-9]/g, "").replace(/^0+/, "").length;
    if (significantDigits > 15) return trimmed;
    return Number(trimmed);
  }

  // Date / Datetime / Time -- accept raw string, let DB validate
  if (isDateColumn(column) || isDateTimeColumn(column) || isTimeColumn(column)) {
    return trimmed;
  }

  // JSON / JSONB -- validate JSON structure
  if (isJSONColumn(column)) {
    try {
      JSON.parse(trimmed);
    } catch {
      throw new Error("Invalid JSON format.");
    }
    return trimmed;
  }

  // BLOB / Binary -- validate hex format
  if (isBlobColumn(column)) {
    const normalized = trimmed.replace(/\s+/g, "").toLowerCase();
    if (!/^[0-9a-f]*$/i.test(normalized) || normalized.length % 2 !== 0) {
      throw new Error("Invalid hex format. Use space-separated bytes (e.g. '48 65 6c 6c 6f').");
    }
    return trimmed;
  }

  return rawValue;
}

export function areCellValuesEqual(left: GridCellValue, right: GridCellValue) {
  if (left === right) return true;
  if (left === null || right === null) return left === right;
  return String(left) === String(right);
}

export function buildRowPrimaryKeys(
  rowValues: unknown[],
  resolvedColumns: ResolvedColumn[],
  primaryKeyColumns: ResolvedColumn[],
): RowKeyValue[] {
  return primaryKeyColumns.map((pkColumn) => {
    const pkIndex = resolvedColumns.findIndex((column) => column.name === pkColumn.name);
    return {
      column: pkColumn.name,
      value: (rowValues[pkIndex] as GridCellValue) ?? null,
    };
  });
}
