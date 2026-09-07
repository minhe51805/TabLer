import type {
  ColumnDetail,
  DatabaseType,
  ForeignKeyInfo,
  IndexInfo,
  TriggerInfo,
} from "../../../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SectionKey = "columns" | "indexes" | "foreign_keys" | "triggers" | "view_definition";
export type DefaultMode = "keep" | "set" | "drop";
export type SqlDialectFamily = "mysql" | "postgresql" | "sqlite";

export interface ColumnEditorState {
  originalName: string;
  name: string;
  dataType: string;
  nullable: boolean;
  defaultMode: DefaultMode;
  defaultValue: string;
  isPrimaryKey: boolean;
  extra: string;
}

export interface BuildColumnSqlResult {
  statements: string[];
  error?: string;
}

export interface StagedColumnChange {
  original: ColumnDetail;
  draft?: ColumnEditorState;
  statements: string[];
  action: "edit" | "drop";
}

// ---------------------------------------------------------------------------
// SQL Dialect Helpers
// ---------------------------------------------------------------------------

export function resolveSqlDialect(dbType: DatabaseType): SqlDialectFamily {
  switch (dbType) {
    case "mysql":
    case "mariadb":
      return "mysql";
    case "sqlite":
    case "duckdb":
    case "libsql":
    case "cloudflare_d1":
      return "sqlite";
    default:
      return "postgresql";
  }
}

export function quoteIdentifier(dbType: DatabaseType, value: string) {
  const normalized = value.trim();
  if (resolveSqlDialect(dbType) === "mysql") {
    return `\`${normalized.replace(/`/g, "``")}\``;
  }
  return `"${normalized.replace(/"/g, "\"\"")}"`;
}

export function qualifyTableName(dbType: DatabaseType, tableName: string, database?: string) {
  const dialect = resolveSqlDialect(dbType);
  const parts = tableName
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);

  if (dialect === "mysql" && parts.length === 1 && database) {
    parts.unshift(database);
  }

  return parts.map((part) => quoteIdentifier(dbType, part)).join(".");
}

export function splitQualifiedTableName(table: string) {
  const [schema, ...rest] = table.split(".");
  if (rest.length === 0) {
    return { schema: "public", name: schema };
  }
  return {
    schema,
    name: rest.join("."),
  };
}

export function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function referencesColumnInSql(sql: string | undefined, columnName: string) {
  if (!sql) return false;
  const pattern = new RegExp(
    `(^|[^a-zA-Z0-9_])(?:${escapeRegex(columnName)}|"${escapeRegex(columnName)}"|\`${escapeRegex(columnName)}\`)(?=$|[^a-zA-Z0-9_])`,
    "i"
  );
  return pattern.test(sql);
}

// ---------------------------------------------------------------------------
// SQL Builders
// ---------------------------------------------------------------------------

export function buildColumnAlterStatements(
  dbType: DatabaseType,
  tableName: string,
  database: string | undefined,
  original: ColumnDetail,
  editor: ColumnEditorState
): BuildColumnSqlResult {
  const dialect = resolveSqlDialect(dbType);

  if (dialect === "sqlite") {
    return {
      statements: [],
      error: "SQLite column changes are not wired into direct actions yet.",
    };
  }

  const nextName = editor.name.trim();
  const nextType = editor.dataType.trim();
  const originalType = (original.column_type || original.data_type || "").trim();
  const originalDefault = (original.default_value || "").trim();
  const nextDefault = editor.defaultValue.trim();
  const tableRef = qualifyTableName(dbType, tableName, database);
  const statements: string[] = [];

  if (!nextName) {
    return { statements: [], error: "Column name is required." };
  }

  if (!nextType) {
    return { statements: [], error: "Column type is required." };
  }

  let currentName = original.name;

  if (nextName !== original.name) {
    statements.push(
      `ALTER TABLE ${tableRef} RENAME COLUMN ${quoteIdentifier(dbType, original.name)} TO ${quoteIdentifier(dbType, nextName)}`
    );
    currentName = nextName;
  }

  if (dialect === "postgresql") {
    if (nextType !== originalType) {
      statements.push(
        `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdentifier(dbType, currentName)} TYPE ${nextType}`
      );
    }

    if (!original.is_primary_key && editor.nullable !== original.is_nullable) {
      statements.push(
        `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdentifier(dbType, currentName)} ${editor.nullable ? "DROP" : "SET"} NOT NULL`
      );
    }

    if (editor.defaultMode === "set") {
      if (!nextDefault) {
        return { statements: [], error: "Default expression is empty." };
      }
      if (nextDefault !== originalDefault) {
        statements.push(
          `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdentifier(dbType, currentName)} SET DEFAULT ${nextDefault}`
        );
      }
    }

    if (editor.defaultMode === "drop" && originalDefault) {
      statements.push(
        `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdentifier(dbType, currentName)} DROP DEFAULT`
      );
    }

    return { statements };
  }

  const definitionChanged = nextType !== originalType || editor.nullable !== original.is_nullable;
  const extraClause = editor.extra.trim();

  if (definitionChanged) {
    const parts = [
      `ALTER TABLE ${tableRef} MODIFY COLUMN ${quoteIdentifier(dbType, currentName)} ${nextType}`,
      editor.nullable && !editor.isPrimaryKey ? "NULL" : "NOT NULL",
    ];

    if (editor.defaultMode === "set") {
      if (!nextDefault) {
        return { statements: [], error: "Default expression is empty." };
      }
      parts.push(`DEFAULT ${nextDefault}`);
    } else if (editor.defaultMode === "keep" && originalDefault) {
      parts.push(`DEFAULT ${originalDefault}`);
    }

    if (extraClause && extraClause !== "-") {
      parts.push(extraClause);
    }

    statements.push(parts.join(" "));
    return { statements };
  }

  if (editor.defaultMode === "set") {
    if (!nextDefault) {
      return { statements: [], error: "Default expression is empty." };
    }
    if (nextDefault !== originalDefault) {
      statements.push(
        `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdentifier(dbType, currentName)} SET DEFAULT ${nextDefault}`
      );
    }
  }

  if (editor.defaultMode === "drop" && originalDefault) {
    statements.push(
      `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdentifier(dbType, currentName)} DROP DEFAULT`
    );
  }

  return { statements };
}

export function buildDropColumnStatements(
  dbType: DatabaseType,
  tableName: string,
  database: string | undefined,
  original: ColumnDetail,
  indexes: IndexInfo[],
  foreignKeys: ForeignKeyInfo[],
  triggers: TriggerInfo[]
): BuildColumnSqlResult {
  if (original.is_primary_key) {
    return {
      statements: [],
      error: "Primary key columns cannot be deleted from this panel.",
    };
  }

  const indexedBy = indexes.filter((index) => index.columns.includes(original.name));
  if (indexedBy.length > 0) {
    return {
      statements: [],
      error: `Column "${original.name}" is used by index ${indexedBy.map((index) => index.name).join(", ")}.`,
    };
  }

  const referencedByForeignKey = foreignKeys.find((foreignKey) => foreignKey.column === original.name);
  if (referencedByForeignKey) {
    return {
      statements: [],
      error: `Column "${original.name}" is used by foreign key ${referencedByForeignKey.name}.`,
    };
  }

  const dependentTriggers = triggers.filter((trigger) =>
    referencesColumnInSql(trigger.definition, original.name)
  );
  if (dependentTriggers.length > 0) {
    return {
      statements: [],
      error: `Column "${original.name}" appears in trigger ${dependentTriggers
        .map((trigger) => trigger.name)
        .join(", ")}. Update or remove those triggers first.`,
    };
  }

  const tableRef = qualifyTableName(dbType, tableName, database);
  return {
    statements: [
      `ALTER TABLE ${tableRef} DROP COLUMN ${quoteIdentifier(dbType, original.name)}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Editor State Helpers
// ---------------------------------------------------------------------------

export function createEditorState(column: ColumnDetail, draft?: ColumnEditorState): ColumnEditorState {
  if (draft) {
    return { ...draft };
  }

  return {
    originalName: column.name,
    name: column.name,
    dataType: column.column_type || column.data_type,
    nullable: column.is_nullable,
    defaultMode: column.default_value ? "keep" : "drop",
    defaultValue: column.default_value || "",
    isPrimaryKey: column.is_primary_key,
    extra: column.extra || "",
  };
}

export function applyDraftToColumn(column: ColumnDetail, draft?: ColumnEditorState): ColumnDetail {
  if (!draft) return column;

  return {
    ...column,
    name: draft.name.trim() || column.name,
    data_type: draft.dataType.trim() || column.data_type,
    column_type: draft.dataType.trim() || column.column_type || column.data_type,
    is_nullable: draft.nullable,
    default_value:
      draft.defaultMode === "set"
        ? draft.defaultValue.trim() || undefined
        : draft.defaultMode === "drop"
          ? undefined
          : column.default_value,
    extra: draft.extra.trim() || column.extra,
  };
}

export function getDefaultValueForType(dataType: string) {
  const type = dataType.toLowerCase();
  if (
    type.includes("int") ||
    type.includes("float") ||
    type.includes("double") ||
    type.includes("decimal") ||
    type.includes("numeric") ||
    type.includes("real")
  ) {
    return "0";
  }
  if (type.includes("bool")) {
    return "false";
  }
  if (type.includes("uuid")) {
    return "gen_random_uuid()";
  }
  if (type.includes("date") || type.includes("time")) {
    return "CURRENT_TIMESTAMP";
  }
  if (type.includes("json")) {
    return "'{}'::jsonb";
  }
  return "''";
}

// ---------------------------------------------------------------------------
// Error / Message Utilities
// ---------------------------------------------------------------------------

export function formatDbError(error: unknown, tableName: string) {
  const message = error instanceof Error ? error.message : String(error);
  const displayTable = tableName.split(".").pop() || tableName;

  if (message.includes("must be owner of table")) {
    return `Permission denied: You are not the owner of "${displayTable}".\n\nPossible solutions:\n1. Connect as the table owner (usually the user who created it)\n2. Ask the owner to run: ALTER TABLE "${displayTable}" OWNER TO your_username\n3. Use "Open SQL" to draft the query and send it to the DBA`;
  }

  if (message.includes("permission denied")) {
    return `Permission denied: ${message}\n\nThis is a database-level restriction, not an app issue.`;
  }

  if (message.includes("cannot insert multiple commands into a prepared statement")) {
    return `The database rejected multiple SQL statements in one request.\n\nRun them one by one, or use the SQL editor batch runner so each statement is sent separately.`;
  }

  if (message.includes("502") || message.includes("Bad Gateway") || message.includes("timeout")) {
    return `Connection timeout (HTTP 502): The database server took too long to respond.\n\nThis is often caused by:\n1. Supabase pooler being slow - try using port 5432 instead of 6543\n2. Query taking too long\n3. Network issues\n\nTry again or use a different connection port.`;
  }

  if (message.includes("connection refused") || message.includes("ECONNREFUSED")) {
    return `Connection refused: Cannot connect to the database server.\n\nPlease check:\n1. Is the server running?\n2. Is the host/port correct?\n3. Is your IP allowed in the database firewall?`;
  }

  if (message.includes("contains null values")) {
    return "Column still contains NULL values. Fill them before setting NOT NULL.";
  }

  return message;
}

export function summarizeToastMessage(message: string, maxLength = 150) {
  const firstParagraph = message.split(/\n\s*\n/)[0]?.trim() || message.trim();
  const compact = firstParagraph.replace(/\s+/g, " ").trim();

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 1).trimEnd()}...`;
}
