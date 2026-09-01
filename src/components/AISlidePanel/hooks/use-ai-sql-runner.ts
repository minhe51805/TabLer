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
import { requestAISqlConfirmation } from "../ai-sql-confirm";
import { summarizeRunResult } from "../ai-sql-response";
import type { AIWorkspaceAgentAutonomy } from "../ai-workspace-types";

export interface AIExecutedSqlResult {
  queryResult: QueryResult;
  summary: string;
}

export interface AIRunSqlOptions {
  /** Autonomy granted by the user for this run ("full" replaces the per-run dialog). */
  agentAutonomy?: AIWorkspaceAgentAutonomy;
}

interface UseAISqlRunnerOptions {
  connectionId: string | null;
  executeSandboxQuery: (
    connectionId: string,
    statements: string[],
    requireReadOnly?: boolean,
    options?: { userInitiated?: boolean; preApproved?: boolean },
  ) => Promise<QueryResult>;
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

  const runSql = useCallback(async (sql: string, runOptions?: AIRunSqlOptions): Promise<AIExecutedSqlResult> => {
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

    const confirmationRequirement = getAISqlConfirmationRequirement(
      statements,
      runOptions?.agentAutonomy,
    );
    const hasMutatingStatements = confirmationRequirement !== null;
    setIsRunning(true);
    setError(null);

    try {
      const activeDatabase = useConnectionStore.getState().currentDatabase;
      if (targetDatabaseFromUse && activeDatabase !== targetDatabaseFromUse) {
        await switchDatabase(connectionId, targetDatabaseFromUse);
      }

      // No dialog for read-only-classified runs or under the standing
      // "full autonomy" grant; otherwise the review dialog gates the run.
      const confirmed =
        confirmationRequirement === null ||
        (await requestAISqlConfirmation(confirmationRequirement, statements));
      if (!confirmed) throw new Error("Execution cancelled.");

      // Only claim Safe-Mode pre-approval when it is real: the standing
      // "full autonomy" grant, or the review dialog was actually shown and
      // approved. Read-classified runs (no dialog) must NOT claim it — the
      // backend's stricter parser then stays fail-closed on anything the
      // frontend regex mis-reads as a read (e.g. mutating CTEs).
      const preApproved =
        runOptions?.agentAutonomy === "full" || confirmationRequirement !== null;
      const queryResult = await executeSandboxQuery(connectionId, statements, undefined, { preApproved });
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
