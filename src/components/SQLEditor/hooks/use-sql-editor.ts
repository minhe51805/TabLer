import { useRef, useCallback, useEffect, useState, type RefObject } from "react";
import type { OnMount } from "@monaco-editor/react";
import { initVimMode, type VimAdapterInstance } from "monaco-vim";
import { useAppStore } from "../../../stores/appStore";
import { useEditorPreferencesStore } from "../../../stores/editorPreferencesStore";
import { useQueryHistoryStore } from "../../../stores/queryHistoryStore";
import type { QueryResult } from "../../../types";
import { translateCurrent } from "../../../i18n";
import { splitSqlStatements } from "../../../utils/sqlStatements";
import { getQueryProfile } from "../../../utils/query-profile";
import {
  formatExecutionError,
  normalizeStatementForGuard,
  extractLeadingUseDirective,
  isSessionSwitchStatement,
  isMutatingStatement,
  isHighRiskStatement,
} from "../SQLEditorUtils";
import { registerInlineAICompletionProvider } from "../SQLEditorAICompletion";
import { registerSchemaCompletionProvider, defineTableRTheme } from "../SQLEditorMonacoSetup";
import { formatSql } from "../../../utils/sql-formatter";
import { parseExplainOutput, buildExplainQuery, type ParsedExplainPlan } from "../../../utils/explain-parser";

export interface QueryChromeState {
  isRunning: boolean;
  executionTimeMs?: number;
  rowCount?: number;
  affectedRows?: number;
  queryCount?: number;
}

export interface QueryEditorSessionState {
  result: QueryResult | null;
  error: string | null;
  notice: string | null;
  queryCount: number;
  editorHeight: number;
  showResultsPane: boolean;
  explainPlan?: ParsedExplainPlan;
}

export interface UseSQLEditorOptions {
  connectionId: string;
  tabId?: string;
  initialContent: string;
  vimStatusRef?: RefObject<HTMLDivElement | null>;
  initialState?: QueryEditorSessionState;
  runRequestNonce: number;
  onChromeChange?: (state: QueryChromeState) => void;
  onStateChange?: (state: QueryEditorSessionState) => void;
}

export function useSQLEditor({
  connectionId,
  tabId,
  initialContent,
  vimStatusRef,
  initialState,
  runRequestNonce,
  onChromeChange,
  onStateChange,
}: UseSQLEditorOptions) {
  const connections = useAppStore((state) => state.connections);
  const executeQuery = useAppStore((state) => state.executeQuery);
  const executeSandboxQuery = useAppStore((state) => state.executeSandboxQuery);
  const switchDatabase = useAppStore((state) => state.switchDatabase);
  const updateTab = useAppStore((state) => state.updateTab);
  const saveQueryEntry = useQueryHistoryStore((state) => state.saveEntry);
  const isVimModeEnabled = useEditorPreferencesStore((state) => state.vimModeEnabled);
  const dbType = connections.find((connection) => connection.id === connectionId)?.db_type;
  const queryProfile = getQueryProfile(dbType);
  const usesDirectExecution = queryProfile.executionPath === "direct";

  const editorRef = useRef<any>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const inlineCompletionDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const completionDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const selectionContextDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const contentPersistTimerRef = useRef<number | null>(null);
  const vimModeRef = useRef<VimAdapterInstance | null>(null);
  const contentDraftRef = useRef(initialContent);
  const onChromeChangeRef = useRef(onChromeChange);
  const onStateChangeRef = useRef(onStateChange);
  const inlineCompletionCacheRef = useRef<{ key: string; value: string; timestamp: number } | null>(null);
  const inlineCompletionInFlightRef = useRef<{ key: string; promise: Promise<string> } | null>(null);
  const lastInlineCompletionAtRef = useRef(0);
  const dailyInlineCompletionRef = useRef({ count: 0, date: new Date().toDateString() });
  const lastRunRequestNonceRef = useRef(runRequestNonce);

  const [result, setResult] = useState<QueryResult | null>(() => initialState?.result ?? null);
  const [error, setError] = useState<string | null>(() => initialState?.error ?? null);
  const [notice, setNotice] = useState<string | null>(() => initialState?.notice ?? null);
  const [queryCount, setQueryCount] = useState(() => initialState?.queryCount ?? 0);
  const [editorHeight, setEditorHeight] = useState(() => initialState?.editorHeight ?? 42);
  const [showResultsPane, setShowResultsPane] = useState(() => {
    const initialRowCount = initialState?.result?.rows.length ?? 0;
    return initialRowCount > 0;
  });
  const [isBatchExecuting, setIsBatchExecuting] = useState(false);
  const [isExecutingCurrent, setIsExecutingCurrent] = useState(false);
  const [explainPlan, setExplainPlan] = useState<ParsedExplainPlan | undefined>(() => initialState?.explainPlan);
  const [isRunningExplain, setIsRunningExplain] = useState(false);

  const flushPersistedContent = useCallback(() => {
    if (!tabId) return;
    if (contentPersistTimerRef.current !== null) {
      window.clearTimeout(contentPersistTimerRef.current);
      contentPersistTimerRef.current = null;
    }
    updateTab(tabId, { content: contentDraftRef.current });
  }, [tabId, updateTab]);

  const schedulePersistedContent = useCallback(
    (value: string) => {
      if (!tabId) return;
      contentDraftRef.current = value;
      if (contentPersistTimerRef.current !== null) {
        window.clearTimeout(contentPersistTimerRef.current);
      }
      contentPersistTimerRef.current = window.setTimeout(() => {
        contentPersistTimerRef.current = null;
        updateTab(tabId, { content: value });
      }, 180);
    },
    [tabId, updateTab]
  );

  useEffect(() => {
    onChromeChangeRef.current = onChromeChange;
  }, [onChromeChange]);

  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  const handleExecute = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || isBatchExecuting) return;

    const selection = editor.getSelection();
    let sql = "";
    if (selection && !selection.isEmpty()) {
      sql = editor.getModel()?.getValueInRange(selection) || "";
    } else {
      sql = editor.getValue();
    }
    if (!sql.trim()) {
      setError(null);
      setResult(null);
      setNotice(translateCurrent("tabs.noSqlToExecute"));
      editor.focus();
      return;
    }

    if (usesDirectExecution) {
      const commandText = sql.trim();
      setNotice(null);
      setError(null);
      setIsExecutingCurrent(true);
      setIsBatchExecuting(true);

      try {
        const queryResult = await executeQuery(connectionId, commandText);
        setResult(queryResult);
        if (queryResult.rows.length > 0) {
          setShowResultsPane(true);
        }
        setQueryCount((c) => c + 1);

        void saveQueryEntry(
          commandText,
          connectionId,
          Number(queryResult.execution_time_ms),
          queryResult.rows.length || undefined,
          undefined,
          useAppStore.getState().currentDatabase || undefined
        );
      } catch (e) {
        const errorMessage = formatExecutionError(e);
        setError(errorMessage);
        setResult(null);
        setNotice(null);

        void saveQueryEntry(
          commandText,
          connectionId,
          0,
          undefined,
          errorMessage,
          useAppStore.getState().currentDatabase || undefined
        );
      } finally {
        setIsExecutingCurrent(false);
        setIsBatchExecuting(false);
      }

      return;
    }

    let sqlToExecute = sql;
    let targetDatabaseFromUse: string | null = null;
    const leadingUseDirective = extractLeadingUseDirective(sql);

    if (leadingUseDirective) {
      if ("error" in leadingUseDirective) {
        setNotice(null);
        setError(leadingUseDirective.error);
        setResult(null);
        return;
      }
      targetDatabaseFromUse = leadingUseDirective.database;
      sqlToExecute = leadingUseDirective.remainingSql;
    }

    const statements = splitSqlStatements(sqlToExecute);
    if (statements.length === 0) {
      if (targetDatabaseFromUse) {
        try {
          const activeDatabase = useAppStore.getState().currentDatabase;
          if (activeDatabase !== targetDatabaseFromUse) {
            await switchDatabase(connectionId, targetDatabaseFromUse);
          }
          setError(`Active database is now ${targetDatabaseFromUse}. Run your SQL statement next.`);
          setResult(null);
        } catch (err) {
          setError(formatExecutionError(err));
        }
      }
      return;
    }

    let statementsToExecute = statements;

    if (statementsToExecute.some(isSessionSwitchStatement)) {
      setError(
        "Sandbox gateway does not allow session-switch statements like USE, ATTACH, or SET search_path. Choose the active database from the app UI first, then run the query."
      );
      setResult(null);
      return;
    }

    const hasMutatingStatements = statementsToExecute.some(isMutatingStatement);
    const hasHighRiskStatements = statementsToExecute.some(isHighRiskStatement);

    setNotice(null);
    setError(null);
    setIsExecutingCurrent(true);
    setIsBatchExecuting(true);
    try {
      const activeDatabase = useAppStore.getState().currentDatabase;
      if (targetDatabaseFromUse && activeDatabase !== targetDatabaseFromUse) {
        await switchDatabase(connectionId, targetDatabaseFromUse);
      }

      if (hasHighRiskStatements) {
        const confirmed = window.confirm(
          "Sandbox gateway detected a high-risk SQL statement. TableR will send it through the protected execution boundary and it will apply real changes to the database. Continue?"
        );
        if (!confirmed) return;
      } else if (hasMutatingStatements) {
        const confirmed = window.confirm(
          "Sandbox gateway will apply these SQL changes to the database for real after policy checks. Continue?"
        );
        if (!confirmed) return;
      }

      const queryResult = await executeSandboxQuery(connectionId, statementsToExecute);
      setResult(queryResult);
      if (queryResult.rows.length > 0) {
        setShowResultsPane(true);
      }
      setQueryCount((c) => c + 1);

      // Auto-save to query history
      void saveQueryEntry(
        sqlToExecute,
        connectionId,
        Number(queryResult.execution_time_ms),
        queryResult.rows.length || undefined,
        undefined,
        activeDatabase || undefined
      );

      if (hasMutatingStatements) {
        const invalidateStructure = statementsToExecute.some((stmt) => {
          const normalized = normalizeStatementForGuard(stmt);
          return (
            normalized.startsWith("CREATE ") ||
            normalized.startsWith("ALTER ") ||
            normalized.startsWith("DROP ") ||
            normalized.startsWith("TRUNCATE ") ||
            normalized.startsWith("RENAME ")
          );
        });
        window.dispatchEvent(
          new CustomEvent("table-data-updated", {
            detail: { connectionId, database: useAppStore.getState().currentDatabase || undefined, invalidateStructure },
          })
        );
      }
    } catch (e) {
      const errorMessage = formatExecutionError(e);
      setError(errorMessage);
      setResult(null);
      setNotice(null);

      // Auto-save failed query to history
      void saveQueryEntry(
        sqlToExecute,
        connectionId,
        0,
        undefined,
        errorMessage,
        useAppStore.getState().currentDatabase || undefined
      );
    } finally {
      setIsExecutingCurrent(false);
      setIsBatchExecuting(false);
    }
  }, [connectionId, executeQuery, executeSandboxQuery, isBatchExecuting, saveQueryEntry, switchDatabase, usesDirectExecution]);

  /** Formats the selected text (or entire editor content) using the connection's SQL dialect. */
  const handleFormatSql = useCallback(() => {
    if (!queryProfile.supportsFormatting) return;

    const editor = editorRef.current;
    if (!editor) return;

    const selection = editor.getSelection();
    let sql = "";
    if (selection && !selection.isEmpty()) {
      sql = editor.getModel()?.getValueInRange(selection) || "";
    } else {
      sql = editor.getValue();
    }
    if (!sql.trim()) return;

    const dbType = useAppStore.getState().connections.find((c) => c.id === connectionId)?.db_type;
    const formatted = formatSql(sql, dbType);

    if (selection && !selection.isEmpty()) {
      editor.executeEdits("format-sql", [{ range: selection, text: formatted, forceMoveMarkers: true }]);
    } else {
      editor.setValue(formatted);
      schedulePersistedContent(formatted);
    }
  }, [connectionId, queryProfile.supportsFormatting, schedulePersistedContent]);

  /** Executes EXPLAIN [ANALYZE] on the current editor content and parses the plan. */
  const handleExplain = useCallback(async (analyze = false) => {
    const editor = editorRef.current;
    if (!editor) return;

    const selection = editor.getSelection();
    let sql = "";
    if (selection && !selection.isEmpty()) {
      sql = editor.getModel()?.getValueInRange(selection) || "";
    } else {
      sql = editor.getValue();
    }
    if (!sql.trim()) {
      setError("Nothing to explain. Write a SELECT or DML statement first.");
      return;
    }

    const conn = useAppStore.getState().connections.find((c) => c.id === connectionId);
    const dbType = conn?.db_type ?? "sqlite";

    setIsRunningExplain(true);
    setExplainPlan(undefined);

    try {
      const explainQuery = buildExplainQuery(sql.trim(), dbType, analyze);
      const queryResult = await executeQuery(connectionId, explainQuery);

      // Parse the result — EXPLAIN returns rows with columns
      let rawOutput: unknown = null;
      if (queryResult.rows.length === 1 && queryResult.columns.length === 1) {
        // Common: single row, single text/JSON column
        rawOutput = queryResult.rows[0][0];
      } else if (queryResult.rows.length > 0) {
        // Multiple rows or columns — reconstruct
        rawOutput = queryResult.rows.map((row) => {
          const obj: Record<string, unknown> = {};
          queryResult.columns.forEach((col, i) => {
            obj[col.name] = row[i];
          });
          return obj;
        });
        if (queryResult.rows.length === 1) {
          rawOutput = (rawOutput as Record<string, unknown>[])[0];
        }
      }

      // If raw output is a string (plain text format), try to parse as JSON
      if (typeof rawOutput === "string") {
        try {
          rawOutput = JSON.parse(rawOutput);
        } catch {
          // Keep as-is (text format)
        }
      }

      const plan = parseExplainOutput(dbType, rawOutput);
      setExplainPlan(plan);
    } catch (e) {
      setError(`EXPLAIN failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsRunningExplain(false);
    }
  }, [connectionId, executeQuery]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

    editor.addAction({
      id: "execute-query",
      label: "Execute Query",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => handleExecute(),
    });

    editor.addAction({
      id: "ask-ai",
      label: "Ask AI",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP,
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP,
      ],
      run: () => {
        window.dispatchEvent(new CustomEvent("open-ai-slide-panel"));
      },
    });

    editor.addAction({
      id: "format-sql",
      label: "Format SQL",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
        monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
      ],
      run: () => handleFormatSql(),
    });

    inlineCompletionDisposableRef.current?.dispose();
    inlineCompletionDisposableRef.current = registerInlineAICompletionProvider(
      monaco,
      connectionId,
      inlineCompletionCacheRef,
      inlineCompletionInFlightRef,
      lastInlineCompletionAtRef,
      dailyInlineCompletionRef
    );

    completionDisposableRef.current?.dispose();
    completionDisposableRef.current = queryProfile.surface === "sql"
      ? registerSchemaCompletionProvider(monaco, {
          getTables: () => useAppStore.getState().tables,
          getTableStructure: (tableName: string) =>
            useAppStore.getState().getTableStructure(
              connectionId,
              tableName,
              useAppStore.getState().currentDatabase ?? undefined
            ),
          dbType,
        })
      : null;

    selectionContextDisposableRef.current?.dispose();
    selectionContextDisposableRef.current = editor.onDidChangeCursorSelection(() => {
      const currentSelection = editor.getSelection();
      const text = currentSelection && !currentSelection.isEmpty()
        ? editor.getModel()?.getValueInRange(currentSelection) || ""
        : "";
      window.dispatchEvent(
        new CustomEvent("ai-selection-context", {
          detail: {
            text,
            source: "SQL editor selection",
            tabId,
          },
        })
      );
    });

    defineTableRTheme(monaco);
    editor.updateOptions({ theme: "tabler-dark" });
  };

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    if (!isVimModeEnabled) {
      vimModeRef.current?.dispose();
      vimModeRef.current = null;
      if (vimStatusRef?.current) {
        vimStatusRef.current.textContent = "";
      }
      return;
    }

    vimModeRef.current?.dispose();
    vimModeRef.current = initVimMode(editor, vimStatusRef?.current ?? null);

    return () => {
      vimModeRef.current?.dispose();
      vimModeRef.current = null;
      if (vimStatusRef?.current) {
        vimStatusRef.current.textContent = "";
      }
    };
  }, [isVimModeEnabled, vimStatusRef]);

  useEffect(() => {
    if (!onChromeChangeRef.current) return;
    onChromeChangeRef.current({
      isRunning: isExecutingCurrent || isBatchExecuting,
      executionTimeMs: result?.execution_time_ms,
      rowCount: result?.rows.length,
      affectedRows: result?.affected_rows,
      queryCount: queryCount || undefined,
    });
  }, [isBatchExecuting, isExecutingCurrent, queryCount, result]);

  useEffect(() => {
    if (!result || result.execution_time_ms < 0) return;
    const activityLabel = result.rows.length > 0
      ? usesDirectExecution ? "Command" : "Query"
      : result.affected_rows > 0
        ? result.sandboxed ? "Sandbox" : "Write"
        : usesDirectExecution ? "Command" : "Run";
    window.dispatchEvent(
      new CustomEvent("workspace-activity", {
        detail: { connectionId, label: activityLabel, durationMs: result.execution_time_ms },
      })
    );
  }, [connectionId, result, usesDirectExecution]);

  useEffect(() => {
    if (!onStateChangeRef.current) return;
    onStateChangeRef.current({ result, error, notice, queryCount, editorHeight, showResultsPane, explainPlan });
  }, [editorHeight, error, explainPlan, notice, queryCount, result, showResultsPane]);

  useEffect(() => {
    const onInsertSQLFromAI = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail?.sql && editorRef.current) {
        const sql = customEvent.detail.sql;
        const editor = editorRef.current;
        const selection = editor.getSelection();
        if (selection && !selection.isEmpty()) {
          editor.executeEdits("ai", [{ range: selection, text: sql, forceMoveMarkers: true }]);
        } else {
          const position = editor.getPosition();
          if (position) {
            editor.executeEdits("ai", [{
              range: {
                startLineNumber: position.lineNumber,
                startColumn: position.column,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
              },
              text: sql,
              forceMoveMarkers: true,
            }]);
          }
        }
      }
    };
    window.addEventListener("insert-sql-from-ai", onInsertSQLFromAI);
    return () => window.removeEventListener("insert-sql-from-ai", onInsertSQLFromAI);
  }, []);

  useEffect(() => {
    if (runRequestNonce <= lastRunRequestNonceRef.current) return;
    lastRunRequestNonceRef.current = runRequestNonce;
    void handleExecute();
  }, [handleExecute, runRequestNonce]);

  useEffect(() => {
    return () => {
      flushPersistedContent();
      vimModeRef.current?.dispose();
      inlineCompletionDisposableRef.current?.dispose();
      completionDisposableRef.current?.dispose();
      selectionContextDisposableRef.current?.dispose();
      editorRef.current = null;
    };
  }, [flushPersistedContent]);

  useEffect(() => {
    const handleToggleResultsPane = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (detail?.tabId && tabId && detail.tabId !== tabId) return;
      setShowResultsPane((current) => !current);
    };
    window.addEventListener("toggle-query-results-pane", handleToggleResultsPane);
    return () => window.removeEventListener("toggle-query-results-pane", handleToggleResultsPane);
  }, [tabId]);

  const handleSplitDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitRef.current?.parentElement;
    if (!container) return;
    const startY = e.clientY;
    const startH = editorHeight;
    const containerH = container.getBoundingClientRect().height;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY;
      const pct = startH + (delta / containerH) * 100;
      setEditorHeight(Math.min(80, Math.max(18, pct)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [editorHeight]);

  return {
    result,
    error,
    notice,
    queryCount,
    editorHeight,
    setEditorHeight,
    showResultsPane,
    setShowResultsPane,
    editorRef,
    splitRef,
    handleEditorMount,
    handleExecute,
    handleFormatSql,
    handleExplain,
    handleSplitDrag,
    schedulePersistedContent,
    explainPlan,
    isRunningExplain,
    setExplainPlan,
  };
}
