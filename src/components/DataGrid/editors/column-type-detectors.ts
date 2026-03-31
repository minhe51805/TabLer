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
  return /^(bytea|blob|binary|varbinary|longblob|mediumblob|tinyblob|geometry|text)/i.test(type);
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

export function formatCellValueForDisplay(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
