import type { ColumnDetail, QueryResult, RowKeyValue } from "../../../types";

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
  return `${connectionId}|${database || ""}|${tableName}`;
}

export function buildTableCacheKey(
  connectionId: string,
  tableName: string,
  database?: string,
  page?: number,
  sortColumn?: string | null,
  sortDir?: "ASC" | "DESC",
) {
  return [
    connectionId,
    database || "",
    tableName,
    page ?? 0,
    sortColumn || "",
    sortDir || "",
  ].join("|");
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
  const [cachedConnectionId, cachedDatabase = "", cachedTableName] = key.split("|", 3);
  if (cachedConnectionId !== connectionId) return false;
  if (database !== undefined && cachedDatabase !== (database || "")) return false;
  if (tableName !== undefined && cachedTableName !== tableName) return false;
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
    .map(
      (column) =>
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
  return /(int|numeric|decimal|float|double|real|serial|money)/i.test(
    column.column_type || column.data_type || "",
  );
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
  return /^(time|time without time zone|timewithtimezone)$/i.test(type) && !isDateTimeColumn(column);
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

  if (/^null$/i.test(trimmed)) {
    return null;
  }

  if (isBooleanColumn(column)) {
    if (/^(true|t|1|yes)$/i.test(trimmed)) return true;
    if (/^(false|f|0|no)$/i.test(trimmed)) return false;
    throw new Error("Boolean values must be true or false.");
  }

  if (isNumericColumn(column)) {
    if (!/^[-+]?\d+(\.\d+)?$/.test(trimmed)) {
      throw new Error("Numeric columns only accept valid numbers.");
    }
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
