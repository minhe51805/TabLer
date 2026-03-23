import type { ColumnDraft } from "../ColumnEditor";

export type WizardDialect = "postgres" | "mysql" | "sqlite";

function quoteIdentifier(dialect: WizardDialect, value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (dialect === "mysql") {
    return `\`${trimmed.replace(/`/g, "``")}\``;
  }

  return `"${trimmed.replace(/"/g, "\"\"")}"`;
}

function qualifyName(
  dialect: WizardDialect,
  name: string,
  schema: string,
  database?: string,
) {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return "";
  }

  if (dialect === "postgres") {
    const trimmedSchema = schema.trim() || "public";
    return `${quoteIdentifier(dialect, trimmedSchema)}.${quoteIdentifier(dialect, trimmedName)}`;
  }

  if (dialect === "mysql") {
    const trimmedDatabase = database?.trim();
    if (trimmedDatabase) {
      return `${quoteIdentifier(dialect, trimmedDatabase)}.${quoteIdentifier(dialect, trimmedName)}`;
    }
    return quoteIdentifier(dialect, trimmedName);
  }

  return quoteIdentifier(dialect, trimmedName);
}

function normalizeStatement(sql: string) {
  const trimmed = sql.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

export interface SqlBuildResult {
  sql: string;
  error: string;
}

export function buildTableSql(
  dialect: WizardDialect,
  name: string,
  schema: string,
  database: string | undefined,
  columns: ColumnDraft[],
): SqlBuildResult {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return { sql: "", error: "Table name is required." };
  }

  const sanitizedColumns = columns.filter(
    (column) => column.name.trim() && column.dataType.trim(),
  );

  if (sanitizedColumns.length === 0) {
    return { sql: "", error: "Add at least one column." };
  }

  const duplicateNames = new Set<string>();
  const seenNames = new Set<string>();
  for (const column of sanitizedColumns) {
    const normalized = column.name.trim().toLowerCase();
    if (seenNames.has(normalized)) {
      duplicateNames.add(column.name.trim());
    }
    seenNames.add(normalized);
  }

  if (duplicateNames.size > 0) {
    return {
      sql: "",
      error: `Duplicate column names: ${Array.from(duplicateNames).join(", ")}.`,
    };
  }

  const primaryKeys = sanitizedColumns.filter((column) => column.primaryKey);
  const lines = sanitizedColumns.map((column) => {
    const parts = [
      `${quoteIdentifier(dialect, column.name)} ${column.dataType.trim()}`,
    ];

    if (!column.nullable) {
      parts.push("NOT NULL");
    }

    if (column.defaultValue.trim()) {
      parts.push(`DEFAULT ${column.defaultValue.trim()}`);
    }

    return parts.join(" ");
  });

  if (primaryKeys.length > 0) {
    lines.push(
      `PRIMARY KEY (${primaryKeys
        .map((column) => quoteIdentifier(dialect, column.name))
        .join(", ")})`,
    );
  }

  const tableRef = qualifyName(dialect, trimmedName, schema, database);
  return {
    sql: `CREATE TABLE ${tableRef} (\n  ${lines.join(",\n  ")}\n);`,
    error: "",
  };
}

export function buildViewSql(
  dialect: WizardDialect,
  name: string,
  schema: string,
  database: string | undefined,
  body: string,
): SqlBuildResult {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return { sql: "", error: "View name is required." };
  }

  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return { sql: "", error: "View query is required." };
  }

  const viewRef = qualifyName(dialect, trimmedName, schema, database);
  const replacePrefix = dialect === "sqlite" ? "CREATE VIEW" : "CREATE OR REPLACE VIEW";
  return {
    sql: `${replacePrefix} ${viewRef} AS\n${trimmedBody.replace(/;+\s*$/, "")};`,
    error: "",
  };
}

export type DatabaseType =
  | "mysql"
  | "mariadb"
  | "sqlite"
  | "duckdb"
  | "cassandra"
  | "cockroachdb"
  | "snowflake"
  | "postgresql"
  | "greenplum"
  | "redshift"
  | "mssql"
  | "redis"
  | "mongodb"
  | "vertica"
  | "clickhouse"
  | "bigquery"
  | "libsql"
  | "cloudflare_d1";

export function buildTriggerSql(
  dialect: WizardDialect,
  dbType: DatabaseType,
  name: string,
  schema: string,
  database: string | undefined,
  tableName: string,
  timing: string,
  event: string,
  body: string,
): SqlBuildResult {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return { sql: "", error: "Trigger name is required." };
  }

  if (!tableName.trim()) {
    return { sql: "", error: "Choose a target table for the trigger." };
  }

  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return { sql: "", error: "Trigger body is required." };
  }

  const targetTableRef = qualifyName(dialect, tableName, schema, database);
  const triggerRef = quoteIdentifier(dialect, trimmedName);

  if (dialect === "postgres") {
    if (dbType === "redshift") {
      return {
        sql: "",
        error: "Trigger scaffolding is not enabled for Redshift in this build.",
      };
    }

    const functionName = `${trimmedName}_fn`;
    const functionRef = qualifyName(dialect, functionName, schema, database);
    const returnKeyword = event === "DELETE" ? "OLD" : "NEW";

    return {
      sql: [
        `CREATE OR REPLACE FUNCTION ${functionRef}()`,
        "RETURNS trigger",
        "LANGUAGE plpgsql",
        "AS $$",
        "BEGIN",
        `  ${trimmedBody.replace(/\n/g, "\n  ")}`,
        `  RETURN ${returnKeyword};`,
        "END;",
        "$$;",
        "",
        `DROP TRIGGER IF EXISTS ${triggerRef} ON ${targetTableRef};`,
        `CREATE TRIGGER ${triggerRef}`,
        `${timing} ${event} ON ${targetTableRef}`,
        "FOR EACH ROW",
        `EXECUTE FUNCTION ${functionRef}();`,
      ].join("\n"),
      error: "",
    };
  }

  if (dialect === "mysql") {
    return {
      sql: [
        `DROP TRIGGER IF EXISTS ${triggerRef};`,
        `CREATE TRIGGER ${triggerRef}`,
        `${timing} ${event} ON ${targetTableRef}`,
        "FOR EACH ROW",
        normalizeStatement(trimmedBody),
      ].join("\n"),
      error: "",
    };
  }

  return {
    sql: [
      `DROP TRIGGER IF EXISTS ${triggerRef};`,
      `CREATE TRIGGER ${triggerRef}`,
      `${timing} ${event} ON ${targetTableRef}`,
      "BEGIN",
      `  ${normalizeStatement(trimmedBody).replace(/\n/g, "\n  ")}`,
      "END;",
    ].join("\n"),
    error: "",
  };
}

export function resolveWizardDialect(dbType: DatabaseType): WizardDialect | null {
  switch (dbType) {
    case "postgresql":
    case "greenplum":
    case "cockroachdb":
    case "redshift":
      return "postgres";
    case "mysql":
    case "mariadb":
      return "mysql";
    case "sqlite":
      return "sqlite";
    default:
      return null;
  }
}
