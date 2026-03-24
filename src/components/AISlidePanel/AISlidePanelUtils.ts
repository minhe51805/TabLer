import { splitSqlStatements } from "../../utils/sqlStatements";

import type { ColumnDetail, ForeignKeyInfo, IndexInfo, TableStructure } from "../../types";

export const MAX_TABLE_NAMES_IN_CONTEXT = 40;
export const MAX_SCHEMA_SUMMARIES = 8;
export const MAX_COLUMNS_PER_SUMMARY = 12;
export const MAX_AI_COLUMNS_PER_SUMMARY = 18;
export const MAX_AI_INDEXES_PER_SUMMARY = 6;
export const MAX_AI_FOREIGN_KEYS_PER_SUMMARY = 6;
export const MAX_AI_SCHEMA_CODEC_CACHE_ENTRIES = 96;
export const AI_SCHEMA_CODEC_VERSION = "v2";

export type AISchemaCodecMode = "core" | "relational";

export type SqlRiskLevel = "safe" | "review" | "dangerous";

export interface SqlRiskAnalysis {
  level: SqlRiskLevel;
  reason: string | null;
}

export const PROMPT_IDEAS = [
  {
    title: "Create table",
    prompt: "Create a users table with id, name, email, role, and created_at.",
  },
  {
    title: "Alter schema",
    prompt: "Add a last_login_at column to the users table and backfill it with CURRENT_TIMESTAMP.",
  },
  {
    title: "Write query",
    prompt: "Write a query that shows the top 10 users by order count in the last 30 days.",
  },
];

export function rankTableForPrompt(promptText: string, tableName: string): number {
  const normalizedPrompt = promptText.toLowerCase();
  const normalizedTable = tableName.toLowerCase();
  const tokens = normalizedTable.split(/[^a-z0-9]+/).filter((t) => t.length > 1);

  let score = normalizedPrompt.includes(normalizedTable) ? 10 : 0;
  for (const token of tokens) {
    if (normalizedPrompt.includes(token)) {
      score += token.length >= 5 ? 4 : 2;
    }
  }
  return score;
}

export function pickRelevantTables<T extends { name: string }>(
  promptText: string,
  tables: T[]
): T[] {
  const ranked = tables
    .map((table) => ({ table, score: rankTableForPrompt(promptText, table.name) }))
    .sort((l, r) => r.score - l.score || l.table.name.localeCompare(r.table.name));

  const matched = ranked.filter((item) => item.score > 0).slice(0, MAX_SCHEMA_SUMMARIES);
  if (matched.length === MAX_SCHEMA_SUMMARIES) return matched.map((i) => i.table);

  const usedNames = new Set(matched.map((i) => i.table.name));
  const fallbacks = ranked
    .filter((i) => !usedNames.has(i.table.name))
    .slice(0, MAX_SCHEMA_SUMMARIES - matched.length)
    .map((i) => i.table);

  return [...matched.map((i) => i.table), ...fallbacks];
}

export function summarizeStructure(
  tableName: string,
  columns: Array<{ name: string; data_type: string }>
): string {
  if (columns.length === 0) return `Table ${tableName}`;
  const preview = columns
    .slice(0, MAX_COLUMNS_PER_SUMMARY)
    .map((c) => `${c.name} ${c.data_type}`)
    .join(", ");
  const remaining = columns.length - MAX_COLUMNS_PER_SUMMARY;
  return remaining > 0
    ? `Table ${tableName} (${preview}, +${remaining} more columns)`
    : `Table ${tableName} (${preview})`;
}

export function inferAISchemaCodecMode(promptText: string): AISchemaCodecMode {
  const normalizedPrompt = promptText.toLowerCase();

  const relationalSignals = [
    "join",
    "relationship",
    "relationships",
    "relation",
    "relations",
    "foreign key",
    "foreign keys",
    "reference",
    "references",
    "fk",
    "graph",
    "erd",
    "index",
    "indexes",
    "unique",
    "constraint",
    "performance",
    "query plan",
    "liên quan",
    "quan hệ",
    "khóa ngoại",
    "khoá ngoại",
    "tham chiếu",
    "ràng buộc",
    "chỉ mục",
    "join bảng",
    "sơ đồ",
  ];

  return relationalSignals.some((signal) => normalizedPrompt.includes(signal)) ? "relational" : "core";
}

function sanitizeSchemaToken(value: string) {
  return value
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[|;:{}[\],]/g, "")
    .slice(0, 80);
}

function encodeDataTypeForAI(column: ColumnDetail) {
  const raw = (column.column_type || column.data_type || "unknown").trim().toLowerCase();
  const normalized = raw.replace(/\s+/g, "");

  if (/^(bigint|int8)/.test(normalized)) return "i64";
  if (/^(int|integer|int4|mediumint|smallint|tinyint|serial)/.test(normalized)) return "i32";
  if (/^(decimal|numeric|money)/.test(normalized)) return "num";
  if (/^(float|double|real)/.test(normalized)) return "f64";
  if (/^(bool|boolean|bit)/.test(normalized)) return "bool";
  if (/^(uuid)/.test(normalized)) return "uuid";
  if (/^(json|jsonb)/.test(normalized)) return "json";
  if (/^(timestamp|datetime)/.test(normalized)) return "ts";
  if (/^(date)/.test(normalized)) return "date";
  if (/^(time)/.test(normalized)) return "time";
  if (/^(char|varchar|nvarchar|text|longtext|mediumtext|tinytext|citext)/.test(normalized)) return "str";
  if (/^(blob|binary|varbinary|bytea)/.test(normalized)) return "bin";
  return sanitizeSchemaToken(normalized || "unknown");
}

function encodeColumnForAI(column: ColumnDetail) {
  const flags: string[] = [];
  if (column.is_primary_key) flags.push("pk");
  if (!column.is_nullable) flags.push("nn");
  if (column.default_value !== undefined && column.default_value !== null && String(column.default_value).trim() !== "") {
    flags.push("df");
  }
  if ((column.extra || "").toLowerCase().includes("auto_increment")) {
    flags.push("ai");
  }

  const encoded = `${sanitizeSchemaToken(column.name)}:${encodeDataTypeForAI(column)}`;
  return flags.length > 0 ? `${encoded}!${flags.join("+")}` : encoded;
}

function encodeIndexForAI(index: IndexInfo) {
  const tone = index.is_unique ? "u" : "i";
  const columns = index.columns.map(sanitizeSchemaToken).join(",");
  return `${tone}:${sanitizeSchemaToken(index.name)}[${columns}]`;
}

function encodeForeignKeyForAI(foreignKey: ForeignKeyInfo) {
  const from = sanitizeSchemaToken(foreignKey.column);
  const toTable = sanitizeSchemaToken(foreignKey.referenced_table);
  const toColumn = sanitizeSchemaToken(foreignKey.referenced_column);
  return `${from}>${toTable}.${toColumn}`;
}

export function encodeStructureForAI(
  tableName: string,
  structure: Pick<TableStructure, "columns" | "indexes" | "foreign_keys">,
  options: { mode?: AISchemaCodecMode } = {}
): string {
  const mode = options.mode || "core";
  const encodedColumns = structure.columns
    .slice(0, MAX_AI_COLUMNS_PER_SUMMARY)
    .map(encodeColumnForAI)
    .join(";");
  const remainingColumns = structure.columns.length - Math.min(structure.columns.length, MAX_AI_COLUMNS_PER_SUMMARY);

  const encodedIndexes = structure.indexes
    .slice(0, MAX_AI_INDEXES_PER_SUMMARY)
    .map(encodeIndexForAI)
    .join(";");
  const remainingIndexes = structure.indexes.length - Math.min(structure.indexes.length, MAX_AI_INDEXES_PER_SUMMARY);

  const encodedForeignKeys = structure.foreign_keys
    .slice(0, MAX_AI_FOREIGN_KEYS_PER_SUMMARY)
    .map(encodeForeignKeyForAI)
    .join(";");
  const remainingForeignKeys =
    structure.foreign_keys.length - Math.min(structure.foreign_keys.length, MAX_AI_FOREIGN_KEYS_PER_SUMMARY);

  const parts = [
    `T:${sanitizeSchemaToken(tableName)}`,
    `C:[${encodedColumns}${remainingColumns > 0 ? `;+${remainingColumns}` : ""}]`,
  ];

  if (mode === "relational" && (encodedIndexes || remainingIndexes > 0)) {
    parts.push(`I:[${encodedIndexes}${remainingIndexes > 0 ? `;+${remainingIndexes}` : ""}]`);
  }

  if (mode === "relational" && (encodedForeignKeys || remainingForeignKeys > 0)) {
    parts.push(`F:[${encodedForeignKeys}${remainingForeignKeys > 0 ? `;+${remainingForeignKeys}` : ""}]`);
  }

  return parts.join("|");
}

export function normalizeStatement(statement: string): string {
  return statement.replace(/^--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().toUpperCase();
}

export function analyzeGeneratedSql(sql: string): SqlRiskAnalysis {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) {
    return { level: "dangerous", reason: "The AI response did not contain a usable SQL statement." };
  }

  let hasReviewableChange = false;

  for (const statement of statements) {
    const normalized = normalizeStatement(statement);
    if (!normalized) continue;

    if (
      normalized.startsWith("DROP ") ||
      normalized.startsWith("TRUNCATE ") ||
      normalized.startsWith("ALTER DATABASE") ||
      normalized.startsWith("ALTER ROLE") ||
      normalized.startsWith("CREATE USER") ||
      normalized.startsWith("GRANT ") ||
      normalized.startsWith("REVOKE ")
    ) {
      return { level: "dangerous", reason: "This SQL can change or remove critical database objects or permissions." };
    }

    if (normalized.startsWith("DELETE ") && !/\bWHERE\b/.test(normalized)) {
      return { level: "dangerous", reason: "DELETE without WHERE would affect every row in the target table." };
    }

    if (normalized.startsWith("UPDATE ") && !/\bWHERE\b/.test(normalized)) {
      return { level: "dangerous", reason: "UPDATE without WHERE would affect every row in the target table." };
    }

    if (
      normalized.startsWith("ALTER ") ||
      normalized.startsWith("CREATE ") ||
      normalized.startsWith("INSERT ") ||
      normalized.startsWith("UPDATE ") ||
      normalized.startsWith("DELETE ") ||
      normalized.startsWith("DROP INDEX")
    ) {
      hasReviewableChange = true;
    }
  }

  if (hasReviewableChange) {
    return { level: "review", reason: "This SQL changes data or schema. Review it carefully before inserting or running it." };
  }

  return { level: "safe", reason: null };
}
