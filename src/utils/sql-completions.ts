import type { DatabaseType } from "../types/database";

export interface SqlCompletionSet {
  readonly keywords: readonly string[];
  readonly functions: readonly string[];
  readonly operators: readonly string[];
}


import {
  BASE_KEYWORDS,
  COMMON_FUNCTIONS,
  DB_SPECIFIC_FUNCTIONS,
  DB_SPECIFIC_KEYWORDS,
  OPERATORS,
} from "./sql-completions-data";

/**
 * Database types supported by the completion engine.
 */
const DATABASE_TYPES: readonly DatabaseType[] = [
  "mysql", "mariadb", "sqlite", "duckdb", "cassandra", "cockroachdb",
  "snowflake", "postgresql", "greenplum", "redshift", "mssql", "redis",
  "mongodb", "vertica", "clickhouse", "bigquery", "libsql", "cloudflare_d1",
];

function uniqueFrozen(items: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(items)]);
}

function mergeUniqueFrozen(base: ReadonlySet<string>, extra: readonly string[]): readonly string[] {
  const merged = new Set(base);
  for (const item of extra) merged.add(item);
  return Object.freeze([...merged]);
}

/**
 * Builds the SQL completions map for all supported database types.
 *
 * Base keyword/function lists are computed once and shared (frozen) across
 * database types that have no engine-specific additions, instead of being
 * rebuilt per type. All output arrays are frozen so consumers can safely
 * iterate without defensive copies and V8 keeps them in fast mode.
 */
function buildSqlCompletions(): Record<DatabaseType, SqlCompletionSet> {
  const baseKeywords = uniqueFrozen(BASE_KEYWORDS);
  const baseKeywordsSet = new Set(baseKeywords);

  const baseFunctionsSet = new Set<string>();
  for (const category of Object.values(COMMON_FUNCTIONS)) {
    for (const fn of category) baseFunctionsSet.add(fn);
  }
  const baseFunctions = Object.freeze([...baseFunctionsSet]);

  let sharedKeywords: readonly string[] | null = null;
  let sharedFunctions: readonly string[] | null = null;

  const result = {} as Record<DatabaseType, SqlCompletionSet>;

  for (const dbType of DATABASE_TYPES) {
    const dbKeywords = DB_SPECIFIC_KEYWORDS[dbType];
    const dbFunctions = DB_SPECIFIC_FUNCTIONS[dbType];

    result[dbType] = {
      keywords: dbKeywords?.length
        ? mergeUniqueFrozen(baseKeywordsSet, dbKeywords)
        : (sharedKeywords ??= baseKeywords),
      functions: dbFunctions?.length
        ? mergeUniqueFrozen(baseFunctionsSet, dbFunctions)
        : (sharedFunctions ??= baseFunctions),
      operators: OPERATORS,
    };
  }

  return Object.freeze(result);
}

export const SQL_COMPLETIONS: Record<DatabaseType, SqlCompletionSet> = buildSqlCompletions();

/**
 * Returns the completion set for a given database type.
 * Falls back to postgresql if the type is unknown.
 */
export function getCompletionSet(dbType: DatabaseType | undefined): SqlCompletionSet {
  return (dbType && SQL_COMPLETIONS[dbType]) || SQL_COMPLETIONS.postgresql;
}
