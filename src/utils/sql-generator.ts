/**
 * Client-side SQL statement generator for selected rows.
 * Generates dialect-aware INSERT and UPDATE statements.
 */

import type { DatabaseType } from "../types/database";

/** Identifier quoting style per database dialect. */
type QuoteFn = (name: string) => string;

function quotePostgres(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteMysql(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function quoteMssql(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

function quoteSqlite(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteClickhouse(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function getQuoteFn(dbType: DatabaseType | undefined): QuoteFn {
  switch (dbType) {
    case "postgresql":
    case "greenplum":
    case "redshift":
    case "cockroachdb":
      return quotePostgres;
    case "mysql":
    case "mariadb":
      return quoteMysql;
    case "mssql":
      return quoteMssql;
    case "clickhouse":
      return quoteClickhouse;
    case "sqlite":
    case "duckdb":
    case "libsql":
    case "cloudflare_d1":
      return quoteSqlite;
    default:
      return quoteSqlite;
  }
}

/** Converts a cell value to a SQL literal string. */
function cellToSql(value: unknown, dbType: DatabaseType | undefined): string {
  if (value === null || value === undefined) return "NULL";

  const type = typeof value;
  if (type === "boolean") return value ? "TRUE" : "FALSE";
  if (type === "number") return String(value);

  // Handle arrays and objects (from serde_json::Value arrays/objects)
  if (type === "object") {
    const json = JSON.stringify(value);
    if (dbType === "mssql") {
      return `N'${json.replace(/'/g, "''")}'`;
    }
    return `'${json.replace(/'/g, "''")}'`;
  }

  const str = String(value);

  // MSSQL uses N'...' for unicode strings
  if (dbType === "mssql") {
    return `N'${str.replace(/'/g, "''")}'`;
  }

  // MySQL uses '...' but also supports '' escaping
  if (dbType === "mysql" || dbType === "mariadb") {
    return `'${str.replace(/'/g, "''")}'`;
  }

  // Default: standard SQL '...'
  return `'${str.replace(/'/g, "''")}'`;
}

/**
 * Generates INSERT statements for selected rows.
 * Returns one INSERT per row, each as a separate line for readability.
 */
export function generateInsertSql(
  tableName: string,
  columns: string[],
  rows: (string | number | boolean | null)[][],
  dbType?: DatabaseType,
): string {
  if (rows.length === 0 || columns.length === 0) return "";

  const quote = getQuoteFn(dbType);
  const colList = columns.map(quote).join(", ");
  const lines: string[] = [];

  for (const row of rows) {
    const vals = row.map((v) => cellToSql(v, dbType)).join(", ");
    lines.push(`INSERT INTO ${quote(tableName)} (${colList}) VALUES (${vals});`);
  }

  return lines.join("\n");
}

/**
 * Generates UPDATE statements for selected rows using primary key columns.
 * Each row generates one UPDATE statement.
 */
export function generateUpdateSql(
  tableName: string,
  columns: string[],
  rows: (string | number | boolean | null)[][],
  primaryKeyColumns: string[],
  dbType?: DatabaseType,
): string {
  if (rows.length === 0 || columns.length === 0 || primaryKeyColumns.length === 0) return "";

  const quote = getQuoteFn(dbType);
  const lines: string[] = [];

  const pkSet = new Set(primaryKeyColumns);

  for (const row of rows) {
    const sets: string[] = [];
    const whereParts: string[] = [];

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const val = row[i];
      const sqlVal = cellToSql(val, dbType);

      if (pkSet.has(col)) {
        whereParts.push(`${quote(col)} = ${sqlVal}`);
      } else {
        sets.push(`${quote(col)} = ${sqlVal}`);
      }
    }

    if (sets.length === 0 || whereParts.length === 0) continue;

    lines.push(
      `UPDATE ${quote(tableName)} SET ${sets.join(", ")} WHERE ${whereParts.join(" AND ")};`,
    );
  }

  return lines.join("\n");
}

/**
 * Copies text to the clipboard and returns success.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ─── Parameterized SQL generators ────────────────────────────────────────────
//
// These generate SQL with $.columnName placeholders — useful for building
// reusable SQL templates that can be find-and-replaced or used with query tools.

/**
 * Generates a parameterized INSERT statement using $.columnName placeholders.
 * Single statement — one row per VALUES clause.
 */
export function generateInsertSqlParameterized(
  tableName: string,
  columns: string[],
  dbType?: DatabaseType,
): string {
  if (columns.length === 0) return "";

  const quote = getQuoteFn(dbType);
  const colList = columns.map(quote).join(", ");
  const placeholders = columns.map((col) => `$.${col}`).join(", ");

  return `INSERT INTO ${quote(tableName)} (${colList}) VALUES (${placeholders});`;
}

/**
 * Generates a parameterized UPDATE statement using $.columnName placeholders.
 * SET and WHERE clauses both use $.columnName — non-PK columns in SET, PKs in WHERE.
 */
export function generateUpdateSqlParameterized(
  tableName: string,
  columns: string[],
  primaryKeyColumns: string[],
  dbType?: DatabaseType,
): string {
  if (columns.length === 0 || primaryKeyColumns.length === 0) return "";

  const quote = getQuoteFn(dbType);
  const pkSet = new Set(primaryKeyColumns);

  const sets = columns
    .filter((col) => !pkSet.has(col))
    .map((col) => `${quote(col)} = $.${col}`)
    .join(", ");

  const whereParts = primaryKeyColumns.map((col) => `${quote(col)} = $.${col}`).join(" AND ");

  if (sets.length === 0) return "";

  return `UPDATE ${quote(tableName)} SET ${sets} WHERE ${whereParts};`;
}

/**
 * Generates a parameterized DELETE statement using $.columnName placeholders.
 * WHERE clause uses all provided primary key columns.
 */
export function generateDeleteSqlParameterized(
  tableName: string,
  primaryKeyColumns: string[],
  dbType?: DatabaseType,
): string {
  if (primaryKeyColumns.length === 0) return "";

  const quote = getQuoteFn(dbType);
  const whereParts = primaryKeyColumns.map((col) => `${quote(col)} = $.${col}`).join(" AND ");

  return `DELETE FROM ${quote(tableName)} WHERE ${whereParts};`;
}
