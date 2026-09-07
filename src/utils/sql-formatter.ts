import { format } from "sql-formatter";
import type { DatabaseType } from "../types/database";
import type { SqlLanguage } from "sql-formatter";

/** Maps our internal DatabaseType to sql-formatter dialect names. */
function mapDialect(dbType: DatabaseType | undefined): SqlLanguage {
  switch (dbType) {
    case "postgresql":
    case "greenplum":
    case "redshift":
    case "cockroachdb":
      return "postgresql";
    case "mysql":
      return "mysql";
    case "mariadb":
      return "mariadb";
    case "sqlite":
    case "duckdb":
    case "libsql":
    case "cloudflare_d1":
      return "sqlite";
    case "mssql":
      return "transactsql";
    case "bigquery":
      return "bigquery";
    case "clickhouse":
      return "clickhouse";
    case "snowflake":
      return "snowflake";
    case "cassandra":
    case "vertica":
    case "mongodb":
    case "redis":
    default:
      return "sql";
  }
}

/**
 * Formats a SQL string using the sql-formatter library.
 * Optionally accepts a db_type to select the appropriate dialect.
 */
export function formatSql(sql: string, dialect?: DatabaseType): string {
  const trimmed = sql.trim();
  if (!trimmed) return sql;

  return format(trimmed, {
    language: mapDialect(dialect),
    tabWidth: 2,
    keywordCase: "upper",
  });
}
