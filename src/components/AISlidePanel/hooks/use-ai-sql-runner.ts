import { useCallback, useState } from "react";
import { useConnectionStore } from "../../../stores/connectionStore";
import type { QueryResult } from "../../../types";
import { splitSqlStatements } from "../../../utils/sqlStatements";
import { emitAppToast } from "../../../utils/app-toast";
import {
  extractLeadingUseDirective,
  formatExecutionError,
  isSessionSwitchStatement,
  normalizeStatementForGuard,
} from "../../SQLEditor/SQLEditorUtils";
import { classifyAgentRun } from "../ai-execution-policy";
import { requestAISqlConfirmation } from "../ai-sql-confirm";
import { summarizeRunResult } from "../ai-sql-response";
import type { AIWorkspaceAgentAutonomy } from "../ai-workspace-types";

/** Label baked into the automatic pre-write checkpoint file name. */
const AUTO_CHECKPOINT_LABEL = "auto-before-agent-write";

interface CheckpointResult {
  fileName: string;
  label: string;
  tableCount: number;
  rowCount: number;
}

/** Rows affected above which the post-run /rollback hint is worth showing. */
const ROLLBACK_HINT_THRESHOLD = 100;

export interface AIExecutedSqlResult {
  queryResult: QueryResult;
  summary: string;
}

export interface AIRunSqlOptions {
  /** Autonomy granted by the user for this run ("full" replaces the per-run dialog). */
  agentAutonomy?: AIWorkspaceAgentAutonomy;
  /** Language for the post-write rollback hint toast. */
  language?: string;
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

    const {
      requirement: confirmationRequirement,
      willMutate: hasMutatingStatements,
      preApproved,
    } = classifyAgentRun(statements, runOptions?.agentAutonomy);
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

      // Safety net #1: before any agent-driven write, snapshot the database
      // into a local checkpoint (awaited — it must capture the PRE-write
      // state). Best effort: a failed snapshot never blocks the run.
      let autoCheckpointReady = false;
      if (hasMutatingStatements) {
        try {
          const storeState = useConnectionStore.getState();
          const dbType = storeState.connections.find(
            (connection) => connection.id === connectionId,
          )?.db_type;
          if (dbType) {
            const { invokeWithTimeout } = await import("../../../utils/tauri-utils");
            const ckLanguage = runOptions?.language ?? "en";
            emitAppToast({
              tone: "info",
              title: ckLanguage === "vi" ? "Đang tạo điểm khôi phục…" : "Creating safety checkpoint…",
              description: ckLanguage === "vi" ? "Snapshot database trước khi agent ghi dữ liệu." : "Snapshotting the database before the agent writes.",
              durationMs: 4000,
            });
            // Bounded: a whole-database dump must never freeze the run silently.
            await invokeWithTimeout<CheckpointResult>("create_database_checkpoint", {
              connectionId,
              database: storeState.currentDatabase || null,
              dbType,
              label: AUTO_CHECKPOINT_LABEL,
            }, 60_000, "Safety checkpoint");
            autoCheckpointReady = true;
          }
        } catch {
          const language = runOptions?.language ?? "en";
          emitAppToast({
            tone: "error",
            title: language === "vi" ? "Checkpoint tự động thất bại" : "Auto checkpoint failed",
            description:
              language === "vi"
                ? "Tiếp tục chạy, nhưng /rollback sẽ không có mốc mới. Có thể tạo tay bằng /backup."
                : "Continuing, but /rollback will have no new point. Create one manually with /backup.",
            durationMs: 8_000,
          });
        }
      }

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

      // Safety net #3: surface the rollback path when a write touched a lot
      // of rows. The agent never rolls back on its own — /rollback is the
      // user's call and restores the pre-run snapshot.
      if (hasMutatingStatements && autoCheckpointReady && queryResult.affected_rows >= ROLLBACK_HINT_THRESHOLD) {
        const language = runOptions?.language ?? "en";
        emitAppToast({
          tone: "info",
          title: writeHintTitle(queryResult.affected_rows, language),
          description: writeHintBody(language),
          durationMs: 12_000,
        });
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

/** The runner lives outside i18n providers, so the hint stays bilingual-safe. */
function writeHintTitle(affectedRows: number, language: string): string {
  return language === "vi"
    ? `Lệnh ghi đã ảnh hưởng ${affectedRows} dòng`
    : `Write affected ${affectedRows} row(s)`;
}

function writeHintBody(language: string): string {
  return language === "vi"
    ? "Đã tự lưu checkpoint trước khi chạy. Nếu sai, gõ /rollback để khôi phục."
    : "A pre-run checkpoint was saved automatically. If this was wrong, type /rollback to restore it.";
}
