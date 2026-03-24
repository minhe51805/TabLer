import { useRef, useCallback, useEffect, useState } from "react";
import type { OnMount } from "@monaco-editor/react";
import { useAppStore } from "../../../stores/appStore";
import type { QueryResult } from "../../../types";
import { splitSqlStatements } from "../../../utils/sqlStatements";
import {
  formatExecutionError,
  normalizeStatementForGuard,
  extractLeadingUseDirective,
  isSessionSwitchStatement,
  isMutatingStatement,
  isHighRiskStatement,
} from "../SQLEditorUtils";
import { registerInlineAICompletionProvider } from "../SQLEditorAICompletion";
import { registerStandardCompletionProvider, defineTableRTheme } from "../SQLEditorMonacoSetup";

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
  queryCount: number;
  editorHeight: number;
}

export interface UseSQLEditorOptions {
  connectionId: string;
  tabId?: string;
  initialContent: string;
  initialState?: QueryEditorSessionState;
  runRequestNonce: number;
  onChromeChange?: (state: QueryChromeState) => void;
  onStateChange?: (state: QueryEditorSessionState) => void;
}

export function useSQLEditor({
  connectionId,
  tabId,
  initialContent,
  initialState,
  runRequestNonce,
  onChromeChange,
  onStateChange,
}: UseSQLEditorOptions) {
  const executeSandboxQuery = useAppStore((state) => state.executeSandboxQuery);
  const switchDatabase = useAppStore((state) => state.switchDatabase);
  const updateTab = useAppStore((state) => state.updateTab);

  const editorRef = useRef<any>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const inlineCompletionDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const completionDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const selectionContextDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const contentPersistTimerRef = useRef<number | null>(null);
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
  const [queryCount, setQueryCount] = useState(() => initialState?.queryCount ?? 0);
  const [editorHeight, setEditorHeight] = useState(() => initialState?.editorHeight ?? 42);
  const [showResultsPane, setShowResultsPane] = useState(true);
  const [isBatchExecuting, setIsBatchExecuting] = useState(false);
  const [isExecutingCurrent, setIsExecutingCurrent] = useState(false);

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
    if (!sql.trim()) return;

    let sqlToExecute = sql;
    let targetDatabaseFromUse: string | null = null;
    const leadingUseDirective = extractLeadingUseDirective(sql);

    if (leadingUseDirective) {
      if ("error" in leadingUseDirective) {
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
      setQueryCount((c) => c + 1);

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
      setError(formatExecutionError(e));
      setResult(null);
    } finally {
      setIsExecutingCurrent(false);
      setIsBatchExecuting(false);
    }
  }, [connectionId, executeSandboxQuery, isBatchExecuting, switchDatabase]);

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
    completionDisposableRef.current = registerStandardCompletionProvider(
      monaco,
      () => useAppStore.getState().tables,
      () => {}
    );

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
      ? "Query"
      : result.affected_rows > 0
        ? result.sandboxed ? "Sandbox" : "Write"
        : "Run";
    window.dispatchEvent(
      new CustomEvent("workspace-activity", {
        detail: { connectionId, label: activityLabel, durationMs: result.execution_time_ms },
      })
    );
  }, [connectionId, result]);

  useEffect(() => {
    if (!onStateChangeRef.current) return;
    onStateChangeRef.current({ result, error, queryCount, editorHeight });
  }, [editorHeight, error, queryCount, result]);

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
    queryCount,
    editorHeight,
    setEditorHeight,
    showResultsPane,
    setShowResultsPane,
    editorRef,
    splitRef,
    handleEditorMount,
    handleExecute,
    handleSplitDrag,
    schedulePersistedContent,
  };
}
