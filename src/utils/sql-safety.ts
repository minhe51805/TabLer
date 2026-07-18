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
}

export function classifySqlSafety(sql: string): Promise<SqlSafetyDecision> {
  return invokeWithTimeout<SqlSafetyDecision>(
    "classify_sql_safety",
    { sql },
    5_000,
    "Classifying SQL",
  );
}
