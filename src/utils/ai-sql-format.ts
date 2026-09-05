/**
 * Pretty-prints SQL produced by the AI agent before it is rendered in chat.
 * Uses sql-formatter (already a dependency) with a safe fallback: if the
 * snippet cannot be parsed, the original text is returned untouched so the
 * display never breaks on odd syntax.
 */
import { format, type SqlLanguage } from "sql-formatter";

const DIALECT_BY_LABEL: Partial<Record<string, SqlLanguage>> = {
  postgresql: "postgresql",
  postgres: "postgresql",
  pgsql: "postgresql",
  cockroach: "postgresql",
  cockroachdb: "postgresql",
  redshift: "redshift",
  mysql: "mysql",
  mariadb: "mariadb",
  sqlite: "sqlite",
  libsql: "sqlite",
  mssql: "transactsql",
  tsql: "transactsql",
  transactsql: "transactsql",
  plsql: "plsql",
  "pl/sql": "plsql",
  clickhouse: "clickhouse",
  duckdb: "duckdb",
  snowflake: "snowflake",
  bigquery: "bigquery",
};

export function formatAgentSql(code: string, language?: string): string {
  const trimmed = code.trim();
  if (!trimmed) return code;
  const label = language?.toLowerCase().replace(/\s+/g, "");
  const dialect = (label && DIALECT_BY_LABEL[label]) || "sql";
  try {
    return format(trimmed, {
      language: dialect,
      tabWidth: 2,
      keywordCase: "preserve",
    });
  } catch {
    // Malformed or dialect-specific syntax: show the original text as-is.
    return code;
  }
}
