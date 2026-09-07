import type { ResolvedColumn } from "../hooks/useDataGrid";
import type { ForeignKeyInfo } from "../../../types";

// ─── Type Detection ────────────────────────────────────────────────────────────

export function isBooleanColumn(column: ResolvedColumn): boolean {
  const type = column.column_type || column.data_type || "";
  return /(bool|boolean|bit)/i.test(type);
}

export function isNumericColumn(column: ResolvedColumn): boolean {
  const type = column.column_type || column.data_type || "";
  return /(int|numeric|decimal|float|double|real|serial|money|number)/i.test(type);
}

export function isDateColumn(column: ResolvedColumn): boolean {
  const type = (column.column_type || column.data_type || "").toLowerCase();
  return type === "date";
}

export function isDateTimeColumn(column: ResolvedColumn): boolean {
  const type = (column.column_type || column.data_type || "").toLowerCase();
  return /^(datetime|timestamp|timewithtimezone|timetz)$/i.test(type);
}

export function isTimeColumn(column: ResolvedColumn): boolean {
  const type = (column.column_type || column.data_type || "").toLowerCase();
  return /^(time|time without time zone|timewithtimezone)$/i.test(type) && !isDateTimeColumn(column);
}

export function isJSONColumn(column: ResolvedColumn): boolean {
  const type = (column.column_type || column.data_type || "").toLowerCase();
  return /^(json|jsonb)/.test(type);
}

export function isBlobColumn(column: ResolvedColumn): boolean {
  const type = (column.column_type || column.data_type || "").toLowerCase();
  return /^(bytea|blob|binary|varbinary|longblob|mediumblob|tinyblob|geometry)/i.test(type);
}

export function isGeometryColumn(column: ResolvedColumn): boolean {
  const type = (column.column_type || column.data_type || "").toLowerCase();
  return /^(geometry|geography|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/i.test(type)
    || /^st_(geom|geomfromtext|point|linestring|polygon)/i.test(type);
}

export function isUuidColumn(column: ResolvedColumn): boolean {
  const dataType = (column.data_type || "").toLowerCase();
  const columnType = (column.column_type || "").toLowerCase();
  
  // Explicit UUID/GUID types
  if (/(uuid|guid)/.test(dataType) || /(uuid|guid)/.test(columnType)) return true;
  
  // Smart UUID detection for BINARY(16)
  if (columnType === "binary(16)") return true;
  if (dataType === "binary" && columnType.includes("(16)")) return true;
  
  return false;
}

export function isEnumColumn(column: ResolvedColumn): boolean {
  const dataType = column.data_type || "";
  const columnType = column.column_type || "";

  // PostgreSQL: USER-DEFINED = enum
  if (dataType === "USER-DEFINED") return true;

  // MySQL/MariaDB: column_type starts with "enum("
  if (/^enum\(/i.test(columnType)) return true;

  return false;
}

export function isSetColumn(column: ResolvedColumn): boolean {
  const columnType = column.column_type || "";
  // MySQL/MariaDB: column_type starts with "set("
  return /^set\(/i.test(columnType);
}

export function getSetValues(column: ResolvedColumn): string[] {
  const columnType = column.column_type || "";
  const match = columnType.match(/^set\((.+)\)$/i);
  if (!match) return [];
  const inner = match[1];
  const values: string[] = [];
  const regex = /'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  let m;
  while ((m = regex.exec(inner)) !== null) {
    values.push(m[1].replace(/\\'/g, "'"));
  }
  return values;
}

// ─── Enum Value Extraction ──────────────────────────────────────────────────────

export function getEnumValues(column: ResolvedColumn): string[] {
  const columnType = column.column_type || "";

  // MySQL/MariaDB: extract from column_type like "enum('a','b','c')"
  const enumMatch = columnType.match(/^enum\((.*)\)$/i);
  if (enumMatch) {
    const values = enumMatch[1];
    // Split by comma, strip quotes
    return values
      .split(",")
      .map((v) => {
        const trimmed = v.trim();
        return trimmed.replace(/^['"]|['"]$/g, "");
      })
      .filter(Boolean);
  }

  return [];
}

// ─── Foreign Key Lookup ─────────────────────────────────────────────────────────

export interface FKColumnInfo {
  referenced_table: string;
  referenced_column: string;
  constraint_name: string;
}

export function getForeignKeyForColumn(
  columnName: string,
  allForeignKeys: ForeignKeyInfo[],
): FKColumnInfo | undefined {
  const fk = allForeignKeys.find((fk) => fk.column === columnName);
  if (!fk) return undefined;
  return {
    referenced_table: fk.referenced_table,
    referenced_column: fk.referenced_column,
    constraint_name: fk.name,
  };
}

// ─── Display Helpers ─────────────────────────────────────────────────────────────

export type ColumnDisplayFormat = "default" | "uuid" | "hex" | "text" | "json";

export function formatCellValueForDisplay(
  value: string | number | boolean | null,
  format: ColumnDisplayFormat = "default",
  isBinary = false
): string {
  if (value === null || value === undefined) return "NULL";
  
  let strVal = String(value);

  // If the value is binary/blob data, we need to handle its raw format first
  if (isBinary && typeof value === 'string') {
    // If it's passed as a byte array string like "12,34,56" or similar
    if (/^\d+(,\d+)*$/.test(strVal) && strVal.includes(',')) {
      const bytes = strVal.split(',').map(Number);
      strVal = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  }

  // UUID Formatting (e.g. 32-char hex string -> 8-4-4-4-12 dash format)
  if (format === "uuid" || (format === "default" && isBinary && strVal.length === 32 && /^[0-9a-f]{32}$/i.test(strVal))) {
    // Strip existing dashes if any
    const clean = strVal.replace(/-/g, "");
    if (clean.length === 32) {
      return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`.toLowerCase();
    }
  }

  // Hex Formatting
  if (format === "hex") {
    // If it's already hex, return as is. If it's text, convert back to hex.
    if (!/^[0-9a-fA-F]+$/.test(strVal)) {
       return Array.from(strVal).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase();
    }
    return strVal.toUpperCase();
  }

  // JSON Formatting
  if (format === "json") {
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return strVal;
    }
  }

  if (typeof value === "boolean") return value ? "true" : "false";
  return strVal;
}
