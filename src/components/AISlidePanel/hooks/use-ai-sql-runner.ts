import { useCallback, useState } from "react";
import { useConnectionStore } from "../../../stores/connectionStore";
import type { QueryResult } from "../../../types";
import { splitSqlStatements } from "../../../utils/sqlStatements";
import {
  extractLeadingUseDirective,
  formatExecutionError,
  isSessionSwitchStatement,
  normalizeStatementForGuard,
} from "../../SQLEditor/SQLEditorUtils";
import { getAISqlConfirmationRequirement } from "../ai-execution-policy";
import { summarizeRunResult } from "../ai-sql-response";

export interface AIExecutedSqlResult {
  queryResult: QueryResult;
  summary: string;
}

interface UseAISqlRunnerOptions {
  connectionId: string | null;
  executeSandboxQuery: (connectionId: string, statements: string[]) => Promise<QueryResult>;
  setError: (message: string | null) => void;
  switchDatabase: (connectionId: string, database: string) => Promise<void>;
}

export function useAISqlRunner({
  connectionId,
  executeSandboxQuery,
  setError,
  switchDatabase,
}: UseAISqlRunnerOptions) {
  const [isRunning, setIsRunning] = useState(false);

  const runSql = useCallback(async (sql: string): Promise<AIExecutedSqlResult> => {
    if (!connectionId) {
      const message = "Please connect to a database before running SQL from AI.";
      setError(message);
      throw new Error(message);
    }

    let sqlToExecute = sql.trim();
    if (!sqlToExecute) {
      const message = "There is no SQL to run for this bubble.";
      setError(message);
      throw new Error(message);
    }

    let targetDatabaseFromUse: string | null = null;
    const leadingUseDirective = extractLeadingUseDirective(sqlToExecute);
    if (leadingUseDirective) {
      if ("error" in leadingUseDirective) {
        setError(leadingUseDirective.error);
        throw new Error(leadingUseDirective.error);
      }
      targetDatabaseFromUse = leadingUseDirective.database;
      sqlToExecute = leadingUseDirective.remainingSql;
    }

    const statements = splitSqlStatements(sqlToExecute);
    if (statements.length === 0) {
      if (targetDatabaseFromUse) {
        const activeDatabase = useConnectionStore.getState().currentDatabase;
        if (activeDatabase !== targetDatabaseFromUse) {
          await switchDatabase(connectionId, targetDatabaseFromUse);
        }
        const message = `Active database is now ${targetDatabaseFromUse}. Add a statement after USE if you want the AI bubble to run something.`;
        setError(message);
        throw new Error(message);
      }
      const message = "The SQL bubble did not contain any executable statements.";
      setError(message);
      throw new Error(message);
    }

    if (statements.some(isSessionSwitchStatement)) {
      const message = "Sandbox execution does not allow USE, ATTACH, or search_path statements in the same run. Choose the database from the app UI first.";
      setError(message);
      throw new Error(message);
    }

    const confirmationRequirement = getAISqlConfirmationRequirement(statements);
    const hasMutatingStatements = confirmationRequirement !== null;
    setIsRunning(true);
    setError(null);

    try {
      const activeDatabase = useConnectionStore.getState().currentDatabase;
      if (targetDatabaseFromUse && activeDatabase !== targetDatabaseFromUse) {
        await switchDatabase(connectionId, targetDatabaseFromUse);
      }

      if (confirmationRequirement === "high-risk") {
        const confirmed = window.confirm("The AI agent wants to run a high-risk SQL statement through the protected sandbox. It can apply real database changes. Approve this run?");
        if (!confirmed) throw new Error("Execution cancelled.");
      } else if (confirmationRequirement === "mutation") {
        const confirmed = window.confirm("The AI agent wants to run a write or schema-changing SQL statement through the sandbox. Approve this run?");
        if (!confirmed) throw new Error("Execution cancelled.");
      }

      const queryResult = await executeSandboxQuery(connectionId, statements);
      if (hasMutatingStatements) {
        const invalidateStructure = statements.some((statement) => {
          const normalized = normalizeStatementForGuard(statement);
          return ["CREATE ", "ALTER ", "DROP ", "TRUNCATE ", "RENAME "].some((prefix) => normalized.startsWith(prefix));
        });
        window.dispatchEvent(new CustomEvent("table-data-updated", {
          detail: {
            connectionId,
            database: useConnectionStore.getState().currentDatabase || undefined,
            invalidateStructure,
          },
        }));
      }

      if (queryResult.execution_time_ms >= 0) {
        const activityLabel = queryResult.rows.length > 0
          ? "Query"
          : queryResult.affected_rows > 0
            ? queryResult.sandboxed ? "Sandbox" : "Write"
            : "Run";
        window.dispatchEvent(new CustomEvent("workspace-activity", {
          detail: { connectionId, label: activityLabel, durationMs: queryResult.execution_time_ms },
        }));
      }

      return { queryResult, summary: summarizeRunResult(queryResult) };
    } catch (errorValue) {
      const message = formatExecutionError(errorValue);
      setError(message);
      throw new Error(message);
    } finally {
      setIsRunning(false);
    }
  }, [connectionId, executeSandboxQuery, setError, switchDatabase]);

  return { isRunning, runSql };
}
