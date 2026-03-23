import { splitSqlStatements } from "../../utils/sqlStatements";

export const MAX_TABLE_NAMES_IN_CONTEXT = 40;
export const MAX_SCHEMA_SUMMARIES = 8;
export const MAX_COLUMNS_PER_SUMMARY = 12;

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
