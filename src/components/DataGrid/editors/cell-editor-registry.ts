import type { CellEditorType } from "./types";
import type { ResolvedColumn } from "../hooks/useDataGrid";
import { isBooleanColumn, isNumericColumn, isDateColumn, isDateTimeColumn, isTimeColumn, isJSONColumn, isBlobColumn, isGeometryColumn, getForeignKeyForColumn, getEnumValues, isEnumColumn, isSetColumn } from "./column-type-detectors";

export const detectColumnEditorType = getCellEditorType;
export function getCellEditorType(
  column: ResolvedColumn,
  fkInfo?: { referenced_table: string; referenced_column: string },
  enumValues?: string[],
): CellEditorType {
  // Boolean → checkbox
  if (isBooleanColumn(column)) return "boolean";

  // Foreign key → lookup dropdown
  if (fkInfo) return "foreign_key";

  // SET (MySQL) → multi-select checkboxes
  if (isSetColumn(column)) return "set";

  // Enum → dropdown
  if (isEnumColumn(column) && enumValues && enumValues.length > 0) return "enum";

  // Date / Datetime / Time
  if (isDateTimeColumn(column)) return "datetime";
  if (isDateColumn(column)) return "date";
  if (isTimeColumn(column)) return "time";

  // JSON / JSONB
  if (isJSONColumn(column)) return "json";

  // BLOB / Binary / Geometry
  if (isBlobColumn(column)) return "hex";
  if (isGeometryColumn(column)) return "geometry";

  // Numeric → number input
  if (isNumericColumn(column)) return "numeric";

  // Default → text input
  return "text";
}

// Re-export detectors for convenience
export {
  isBooleanColumn,
  isNumericColumn,
  isDateColumn,
  isDateTimeColumn,
  isTimeColumn,
  isJSONColumn,
  isBlobColumn,
  isEnumColumn,
  getForeignKeyForColumn,
  getEnumValues,
};
