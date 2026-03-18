import { useState, useRef, useCallback, useEffect, lazy, Suspense } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { AlertCircle, Terminal } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import type { QueryResult } from "../../types";
import { splitSqlStatements } from "../../utils/sqlStatements";
import { DataGrid } from "../DataGrid";

interface QueryChromeState {
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
  showTerminal: boolean;
}

interface Props {
  connectionId: string;
  initialContent?: string;
  tabId?: string;
  initialState?: QueryEditorSessionState;
  runRequestNonce?: number;
  onChromeChange?: (state: QueryChromeState) => void;
  onStateChange?: (state: QueryEditorSessionState) => void;
  onTerminalToggle?: (show: boolean) => void;
}

function formatExecutionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error:\s*/, "");
}

const INLINE_COMPLETION_CACHE_MS = 15_000;
const INLINE_COMPLETION_MIN_INTERVAL_MS = 450;
const INLINE_COMPLETION_TABLE_LIMIT = 40;
const TERMINAL_FEATURE_ENABLED = false;
const TerminalPanel = TERMINAL_FEATURE_ENABLED
  ? lazy(() => import("../TerminalPanel").then((module) => ({ default: module.TerminalPanel })))
  : null;

function normalizeInlineSuggestion(rawSuggestion: string, textUntilPosition: string) {
  let suggestion = rawSuggestion
    .replace(/^```[a-z]*\s*\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();

  if (suggestion.toLowerCase().startsWith(textUntilPosition.trim().toLowerCase())) {
    suggestion = suggestion.slice(textUntilPosition.trim().length).trim();
  }

  return suggestion;
}

export function SQLEditor({
  connectionId,
  initialContent = "",
  tabId,
  initialState,
  runRequestNonce = 0,
  onChromeChange,
  onStateChange,
  onTerminalToggle,
}: Props) {
  const executeSandboxQuery = useAppStore((state) => state.executeSandboxQuery);
  const updateTab = useAppStore((state) => state.updateTab);
  const editorRef = useRef<any>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const inlineCompletionDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const completionDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const contentPersistTimerRef = useRef<number | null>(null);
  const contentDraftRef = useRef(initialContent);
  const onChromeChangeRef = useRef(onChromeChange);
  const onStateChangeRef = useRef(onStateChange);
  const inlineCompletionCacheRef = useRef<{ key: string; value: string; timestamp: number } | null>(null);
  const inlineCompletionInFlightRef = useRef<{ key: string; promise: Promise<string> } | null>(null);
  const lastInlineCompletionAtRef = useRef(0);
  const lastRunRequestNonceRef = useRef(runRequestNonce);

  const [result, setResult] = useState<QueryResult | null>(() => initialState?.result ?? null);
  const [error, setError] = useState<string | null>(() => initialState?.error ?? null);
  const [queryCount, setQueryCount] = useState(() => initialState?.queryCount ?? 0);
  const [editorHeight, setEditorHeight] = useState(() => initialState?.editorHeight ?? 42);
  const [showTerminal, setShowTerminal] = useState(() => initialState?.showTerminal ?? false);
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

  const toggleTerminalPanel = useCallback(() => {
    if (!TERMINAL_FEATURE_ENABLED) return;

    setShowTerminal((visible) => {
      const nextVisible = !visible;
      if (onTerminalToggle) {
        onTerminalToggle(nextVisible);
      }
      return nextVisible;
    });
  }, [onTerminalToggle]);

  useEffect(() => {
    onChromeChangeRef.current = onChromeChange;
  }, [onChromeChange]);

  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

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

    // Add Inline AI Auto-completion provider
    inlineCompletionDisposableRef.current?.dispose();
    inlineCompletionDisposableRef.current = monaco.languages.registerInlineCompletionsProvider("sql", {
      provideInlineCompletions: async (model: any, position: any, _context: any, _token: any) => {
        // Only trigger if at the end of a line and we have an active provider
        const textUntilPosition = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        });

        if (textUntilPosition.trim().length < 5) return { items: [] };

        const activeProvider = useAppStore.getState().aiConfigs.find(c => c.is_enabled);
        if (!activeProvider) return { items: [] };
        if (!activeProvider.allow_inline_completion) return { items: [] };

        const dbName = useAppStore.getState().currentDatabase || "Default";
        const completionKey = `${dbName}:${textUntilPosition.trim()}`;
        const cachedSuggestion = inlineCompletionCacheRef.current;
        if (
          cachedSuggestion &&
          cachedSuggestion.key === completionKey &&
          Date.now() - cachedSuggestion.timestamp < INLINE_COMPLETION_CACHE_MS
        ) {
          return cachedSuggestion.value
            ? {
                items: [{
                  insertText: cachedSuggestion.value,
                  range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
                }]
              }
            : { items: [] };
        }

        const inFlightSuggestion = inlineCompletionInFlightRef.current;
        if (inFlightSuggestion?.key === completionKey) {
          const suggestion = await inFlightSuggestion.promise;
          return suggestion
            ? {
                items: [{
                  insertText: suggestion,
                  range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
                }]
              }
            : { items: [] };
        }

        if (Date.now() - lastInlineCompletionAtRef.current < INLINE_COMPLETION_MIN_INTERVAL_MS) {
          return { items: [] };
        }
        lastInlineCompletionAtRef.current = Date.now();

        try {
          // Fetch light schema (just names) for speed during typing
          const tableNameList = activeProvider.allow_schema_context
            ? useAppStore
                .getState()
                .tables
                .slice(0, INLINE_COMPLETION_TABLE_LIMIT)
                .map(t => t.name)
                .join(", ")
            : "";
          const dbContext = activeProvider.allow_schema_context
            ? `Database: ${dbName}\nAvailable Tables: ${tableNameList}\nProvide ONLY the raw SQL code completion. Do not add quotes, markdown, or explanations.`
            : "";

          const prompt = `Complete this SQL query (return only the remaining code):\n${textUntilPosition}`;
          const requestPromise = useAppStore
            .getState()
            .askAI(activeProvider.id, prompt, dbContext, "inline")
            .then((response) => normalizeInlineSuggestion(response, textUntilPosition))
            .finally(() => {
              if (inlineCompletionInFlightRef.current?.key === completionKey) {
                inlineCompletionInFlightRef.current = null;
              }
            });

          inlineCompletionInFlightRef.current = {
            key: completionKey,
            promise: requestPromise,
          };

          const suggestion = await requestPromise;
          inlineCompletionCacheRef.current = {
            key: completionKey,
            value: suggestion,
            timestamp: Date.now(),
          };

          if (suggestion) {
            return {
              items: [{
                insertText: suggestion,
                range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
              }]
            };
          }
        } catch (e) {
          console.error("AI Completion error", e);
        }
        return { items: [] };
      },
      freeInlineCompletions: () => { }
    });

    // Add standard Auto-completion modal (Ctrl+Space) for tables and keywords
    completionDisposableRef.current?.dispose();
    completionDisposableRef.current = monaco.languages.registerCompletionItemProvider("sql", {
      provideCompletionItems: (model: any, position: any) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn
        };

        const currentTables = useAppStore.getState().tables;
        const tableSuggestions = currentTables.map(t => ({
          label: t.name,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: t.name,
          detail: 'Table',
          range
        }));

        const keywords = [
          'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'ORDER BY', 'GROUP BY', 'LIMIT', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON', 'AS', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'DROP TABLE', 'ALTER TABLE'
        ];

        const keywordSuggestions = keywords.map(k => ({
          label: k,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: k,
          detail: 'Keyword',
          range
        }));

        return {
          suggestions: [...tableSuggestions, ...keywordSuggestions]
        };
      }
    });

    monaco.editor.defineTheme("tabler-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "keyword", foreground: "7AA2FF", fontStyle: "bold" },
        { token: "string", foreground: "E8BF7A" },
        { token: "number", foreground: "FFB285" },
        { token: "comment", foreground: "65789A", fontStyle: "italic" },
        { token: "operator", foreground: "9CB7FF" },
      ],
      colors: {
        "editor.background": "#101826",
        "editor.foreground": "#e7ecf8",
        "editor.selectionBackground": "#7aa2ff36",
        "editor.lineHighlightBackground": "#22314f66",
        "editorCursor.foreground": "#aec4ff",
        "editorLineNumber.foreground": "#62779d",
        "editorLineNumber.activeForeground": "#e7ecf8",
      },
    });

    editor.updateOptions({ theme: "tabler-dark" });
  };

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

    const statements = splitSqlStatements(sql);
    if (statements.length === 0) return;

    setError(null);
    setIsExecutingCurrent(true);
    setIsBatchExecuting(true);
    try {
      const queryResult = await executeSandboxQuery(connectionId, statements);
      setResult(queryResult);

      setQueryCount((c) => c + 1);
      setShowTerminal(false);
    } catch (e) {
      setError(formatExecutionError(e));
      setResult(null);
    } finally {
      setIsExecutingCurrent(false);
      setIsBatchExecuting(false);
    }
  }, [connectionId, executeSandboxQuery, isBatchExecuting]);

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
        ? "Preview"
        : "Run";

    window.dispatchEvent(
      new CustomEvent("workspace-activity", {
        detail: {
          connectionId,
          label: activityLabel,
          durationMs: result.execution_time_ms,
        },
      })
    );
  }, [connectionId, result]);

  useEffect(() => {
    if (!onStateChangeRef.current) return;

    onStateChangeRef.current({
      result,
      error,
      queryCount,
      editorHeight,
      showTerminal,
    });
  }, [editorHeight, error, queryCount, result, showTerminal]);

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
                endColumn: position.column
              },
              text: sql,
              forceMoveMarkers: true
            }]);
          }
        }
      }
    };

    window.addEventListener("insert-sql-from-ai", onInsertSQLFromAI);
    return () => {
      window.removeEventListener("insert-sql-from-ai", onInsertSQLFromAI);
    };
  }, []);

  useEffect(() => {
    if (runRequestNonce <= lastRunRequestNonceRef.current) return;
    lastRunRequestNonceRef.current = runRequestNonce;
    void handleExecute();
  }, [handleExecute, runRequestNonce]);

  useEffect(() => {
    if (!TERMINAL_FEATURE_ENABLED) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === "`" || key === "j") {
        e.preventDefault();
        toggleTerminalPanel();
      }
    };

    const onToggleTerminal = () => {
      toggleTerminalPanel();
    };

    const onCloseTerminal = () => {
      setShowTerminal(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("toggle-sql-terminal", onToggleTerminal);
    window.addEventListener("close-sql-terminal", onCloseTerminal);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("toggle-sql-terminal", onToggleTerminal);
      window.removeEventListener("close-sql-terminal", onCloseTerminal);
    };
  }, [handleExecute, tabId, toggleTerminalPanel]);

  useEffect(() => {
    return () => {
      flushPersistedContent();
      inlineCompletionDisposableRef.current?.dispose();
      completionDisposableRef.current?.dispose();
      editorRef.current = null;
    };
  }, [flushPersistedContent]);

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

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex flex-col min-h-0">
        <div
          className="relative overflow-hidden"
          style={{ height: `${editorHeight}%`, minHeight: 96 }}
        >
          <Editor
            defaultLanguage="sql"
            defaultValue={initialContent}
            theme="vs-dark"
            onChange={(value) => {
              if (tabId && value !== undefined) {
                schedulePersistedContent(value);
              }
            }}
            onMount={handleEditorMount}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              wordWrap: "on",
              padding: { top: 10, bottom: 8 },
              suggestOnTriggerCharacters: true,
              quickSuggestions: true,
              tabSize: 2,
              renderLineHighlight: "line",
              bracketPairColorization: { enabled: true },
              autoClosingBrackets: "always",
              automaticLayout: true,
              inlineSuggest: { enabled: true },
              scrollbar: {
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
              },
            }}
          />
        </div>

        <div
          ref={splitRef}
          className="h-[6px] flex-shrink-0 cursor-row-resize group flex items-center justify-center bg-[rgba(255,255,255,0.02)] border-y border-[var(--border-color)] hover:bg-[var(--accent-dim)] transition-colors"
          onMouseDown={handleSplitDrag}
        >
          <div className="w-9 h-[2px] rounded-md bg-[var(--text-muted)]/30 group-hover:bg-[var(--accent)]/60 transition-colors" />
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {TERMINAL_FEATURE_ENABLED && TerminalPanel && showTerminal ? (
            <Suspense fallback={null}>
              <TerminalPanel initialCwd="." />
            </Suspense>
          ) : error ? (
            <div className="flex items-start gap-3 p-4 m-3 bg-[var(--error)]/10 border border-[var(--error)]/30 rounded-md">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[var(--error)]" />
              <div>
                <p className="font-semibold text-[13px] text-[var(--error)]">Query Error</p>
                <pre className="text-[12px] mt-1.5 text-[var(--text-secondary)] whitespace-pre-wrap font-mono leading-relaxed">
                  {error}
                </pre>
              </div>
            </div>
          ) : result ? (
            <DataGrid connectionId={connectionId} queryResult={result} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-[var(--text-secondary)] select-none gap-2">
              <Terminal className="w-8 h-8 opacity-40 text-[var(--accent)]" />
              <p className="text-[12px] opacity-95">
                Press <kbd className="px-1.5 py-0.5 mx-0.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border-color)] text-[11px] font-mono">Ctrl+Enter</kbd> to execute
              </p>
              {TERMINAL_FEATURE_ENABLED && (
                <p className="text-[11px] opacity-70">
                  Press <kbd className="px-1.5 py-0.5 mx-0.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border-color)] text-[10px] font-mono">Ctrl+J</kbd> to open terminal
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

