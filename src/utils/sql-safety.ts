import { invokeWithTimeout } from "./tauri-utils";

export type SqlStatementKind =
  | "read"
  | "write"
  | "schema"
  | "session"
  | "transaction"
  | "unknown";

export interface SqlStatementDecision {
  sql: string;
  kind: SqlStatementKind;
  readOnly: boolean;
}

export interface SqlSafetyDecision {
  statements: SqlStatementDecision[];
  readOnly: boolean;
  hasSchemaMutation: boolean;
  parseError?: string | null;
  /**
   * Set by the Safe Mode guard (not the classifier): the human explicitly
   * approved this exact run — confirmation dialog approved, or the standing
   * full-autonomy grant. Lets the backend relax its level 1-3 block.
   */
  userConfirmed?: boolean;
}

export function classifySqlSafety(sql: string, databaseType?: string | null): Promise<SqlSafetyDecision> {
  return invokeWithTimeout<SqlSafetyDecision>(
    "classify_sql_safety",
    { sql, databaseType: databaseType ?? null },
    5_000,
    "Classifying SQL",
  );
}
