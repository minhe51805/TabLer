import type { ColumnDetail, DatabaseType, TableStructure } from "../types";

export interface ColumnChange {
  column: string;
  before: ColumnDetail;
  after: ColumnDetail;
  fields: Array<"type" | "nullable" | "default">;
}

export interface TableSchemaDiff {
  table: string;
  addedColumns: ColumnDetail[];
  droppedColumns: ColumnDetail[];
  changedColumns: ColumnChange[];
  destructive: string[];
}

export interface SchemaMigrationReview {
  statements: string[];
  warnings: string[];
  destructive: boolean;
}

function normalizedType(column: ColumnDetail) {
  return (column.column_type || column.data_type || "").trim().toLowerCase();
}

function normalizedDefault(column: ColumnDetail) {
  return (column.default_value || "").trim();
}

function quoteIdentifier(dbType: DatabaseType, value: string) {
  if (dbType === "mysql" || dbType === "mariadb") {
    return "`" + value.replace(/`/g, "``") + "`";
  }
  return '"' + value.replace(/"/g, '""') + '"';
}

function tableReference(dbType: DatabaseType, table: string, database?: string) {
  const parts = table.split(".").filter(Boolean);
  if ((dbType === "mysql" || dbType === "mariadb") && database && parts.length === 1) {
    parts.unshift(database);
  }
  return parts.map((part) => quoteIdentifier(dbType, part)).join(".");
}

function columnDefinition(dbType: DatabaseType, column: ColumnDetail) {
  const parts = [quoteIdentifier(dbType, column.name), column.column_type || column.data_type];
  if (!column.is_nullable || column.is_primary_key) parts.push("NOT NULL");
  if (column.default_value) parts.push(`DEFAULT ${column.default_value}`);
  return parts.join(" ");
}

export function diffTableStructure(table: string, before: TableStructure, after: TableStructure): TableSchemaDiff {
  const beforeByName = new Map(before.columns.map((column) => [column.name, column]));
  const afterByName = new Map(after.columns.map((column) => [column.name, column]));
  const addedColumns = after.columns.filter((column) => !beforeByName.has(column.name));
  const droppedColumns = before.columns.filter((column) => !afterByName.has(column.name));
  const changedColumns: ColumnChange[] = [];

  for (const [name, beforeColumn] of beforeByName) {
    const afterColumn = afterByName.get(name);
    if (!afterColumn) continue;
    const fields: ColumnChange["fields"] = [];
    if (normalizedType(beforeColumn) !== normalizedType(afterColumn)) fields.push("type");
    if (beforeColumn.is_nullable !== afterColumn.is_nullable) fields.push("nullable");
    if (normalizedDefault(beforeColumn) !== normalizedDefault(afterColumn)) fields.push("default");
    if (fields.length > 0) changedColumns.push({ column: name, before: beforeColumn, after: afterColumn, fields });
  }

  return {
    table,
    addedColumns,
    droppedColumns,
    changedColumns,
    destructive: droppedColumns.map((column) => `Drop column ${column.name}`),
  };
}

/** Builds review-only migration SQL. Callers must show the output and obtain confirmation before execution. */
export function buildSchemaMigrationReview(
  dbType: DatabaseType,
  diff: TableSchemaDiff,
  database?: string,
): SchemaMigrationReview {
  const table = tableReference(dbType, diff.table, database);
  const statements: string[] = [];
  const warnings = [...diff.destructive.map((change) => `${change} permanently removes data.`)];
  const sqliteFamily = ["sqlite", "duckdb", "libsql", "cloudflare_d1"].includes(dbType);

  if (sqliteFamily && (diff.droppedColumns.length > 0 || diff.changedColumns.length > 0)) {
    for (const column of diff.droppedColumns) {
      warnings.push(`SQLite-family removal of ${column.name} requires a table rebuild; no automatic SQL was generated.`);
    }
    for (const change of diff.changedColumns) {
      warnings.push(`SQLite-family change for ${change.column} requires a table rebuild; no automatic SQL was generated.`);
    }

    for (const column of diff.addedColumns) {
      statements.push(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition(dbType, column)}`);
    }

    return { statements, warnings, destructive: warnings.length > 0 };
  }

  for (const column of diff.addedColumns) {
    statements.push(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition(dbType, column)}`);
  }
  for (const column of diff.droppedColumns) {
    if (column.is_primary_key) {
      warnings.push(`Primary-key column ${column.name} requires a manual migration review.`);
      continue;
    }
    statements.push(`ALTER TABLE ${table} DROP COLUMN ${quoteIdentifier(dbType, column.name)}`);
  }
  for (const change of diff.changedColumns) {
    const column = quoteIdentifier(dbType, change.column);
    if (dbType === "mysql" || dbType === "mariadb") {
      statements.push(`ALTER TABLE ${table} MODIFY COLUMN ${columnDefinition(dbType, change.after)}`);
      continue;
    }
    if (change.fields.includes("type")) {
      statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${change.after.column_type || change.after.data_type}`);
    }
    if (change.fields.includes("nullable")) {
      statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} ${change.after.is_nullable ? "DROP" : "SET"} NOT NULL`);
    }
    if (change.fields.includes("default")) {
      statements.push(
        change.after.default_value
          ? `ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${change.after.default_value}`
          : `ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`,
      );
    }
  }

  return { statements, warnings, destructive: warnings.length > 0 };
}
