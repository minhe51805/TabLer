import type { TableRowFocus } from "../../types";

/**
 * Builds a SQL filter clause that re-selects the focused row across loaded
 * chunks. Invalid identifier characters are skipped defensively.
 */
export function buildRowFocusFilter(rowFocus: TableRowFocus | undefined): string {
  if (!rowFocus) return "";
  const clauses = Object.entries(rowFocus.values).flatMap(([column, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(column)) return [];
    if (value === null) return [`${column} IS NULL`];
    if (typeof value === "number") return [Number.isFinite(value) ? `${column} = ${value}` : ""];
    if (typeof value === "boolean") return [`${column} = ${value ? "TRUE" : "FALSE"}`];
    return [`${column} = '${value.replace(/'/g, "''")}'`];
  }).filter(Boolean);
  return clauses.join(" AND ");
}
