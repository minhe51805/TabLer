import { useState, useRef, useCallback, useEffect } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { AlertCircle, Terminal } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import type { ConnectionConfig, QueryResult } from "../../types";
import { devLogError } from "../../utils/logger";
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
}

interface Props {
  connectionId: string;
  initialContent?: string;
  tabId?: string;
  initialState?: QueryEditorSessionState;
  runRequestNonce?: number;
  onChromeChange?: (state: QueryChromeState) => void;
  onStateChange?: (state: QueryEditorSessionState) => void;
}

function formatExecutionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error:\s*/, "");
}

const INLINE_COMPLETION_CACHE_MS = 120_000;
const INLINE_COMPLETION_MIN_INTERVAL_MS = 2_000;
const INLINE_COMPLETION_TABLE_LIMIT = 40;
const MAX_DAILY_INLINE_COMPLETIONS = 100;
const PROTECTED_RUN_MUTATING_PREFIXES = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "MERGE",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "COMMENT",
  "RENAME",
] as const;
const PROTECTED_RUN_SESSION_PREFIXES = [
  "USE",
  "SET SEARCH_PATH",
  "ATTACH",
  "DETACH",
  "SET ROLE",
  "SET SESSION",
  "SET NAMES",
  "SET CHARACTER SET",
] as const;

function stripLeadingSqlNoise(statement: string) {
  let remaining = statement;

  while (true) {
    remaining = remaining.trimStart();
    if (remaining.startsWith("--")) {
      const nextLineIndex = remaining.indexOf("\n");
      if (nextLineIndex === -1) return "";
      remaining = remaining.slice(nextLineIndex + 1);
      continue;
    }

    if (remaining.startsWith("/*")) {
      const commentEnd = remaining.indexOf("*/");
      if (commentEnd === -1) return "";
      remaining = remaining.slice(commentEnd + 2);
      continue;
    }

    return remaining;
  }
}

function normalizeStatementForGuard(statement: string) {
  return stripLeadingSqlNoise(statement).replace(/\s+/g, " ").trim().toUpperCase();
}

function stripIdentifierWrapper(identifier: string) {
  const trimmed = identifier.trim();
  if (
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function extractLeadingUseDirective(
  sql: string
): { database: string; remainingSql: string } | { error: string } | null {
  const trimmed = stripLeadingSqlNoise(sql).trimStart();
  if (!/^USE\s+/i.test(trimmed)) {
    return null;
  }

  const newlineIndex = trimmed.indexOf("\n");
  const semicolonIndex = trimmed.indexOf(";");
  const endsAtSemicolon =
    semicolonIndex !== -1 && (newlineIndex === -1 || semicolonIndex < newlineIndex);

  const directive = endsAtSemicolon
    ? trimmed.slice(0, semicolonIndex + 1)
    : newlineIndex === -1
      ? trimmed
      : trimmed.slice(0, newlineIndex);
  const remainingSql = endsAtSemicolon
    ? trimmed.slice(semicolonIndex + 1)
    : newlineIndex === -1
      ? ""
      : trimmed.slice(newlineIndex + 1);

  const rawTarget = directive.replace(/^USE\s+/i, "").replace(/;$/, "").trim();
  if (!rawTarget) {
    return {
      error:
        "Sandbox gateway found an empty USE statement. Choose the active database from the UI or provide a database name.",
    };
  }

  const normalizedTarget = stripIdentifierWrapper(rawTarget);
  if (/\s/.test(normalizedTarget)) {
    return {
      error:
        "Sandbox gateway could not understand the USE directive. Use `USE <database>` on its own line before the rest of the SQL.",
    };
  }
  if (normalizedTarget.includes(".")) {
    return {
      error:
        "Sandbox gateway only accepts USE <database>. `USE db.table` is not supported. Choose the database from the UI, or run the write against a fully qualified table like `INSERT INTO db.table ...`.",
    };
  }

  return {
    database: normalizedTarget,
    remainingSql,
  };
}

function isSessionSwitchStatement(statement: string) {
  const normalized = normalizeStatementForGuard(statement);
  return PROTECTED_RUN_SESSION_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isMutatingStatement(statement: string) {
  const normalized = normalizeStatementForGuard(statement);
  if (!normalized) return false;

  if (normalized.startsWith("WITH")) {
    return [" INSERT ", " UPDATE ", " DELETE ", " MERGE "].some((keyword) =>
      normalized.includes(keyword)
    );
  }

  return PROTECTED_RUN_MUTATING_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isHighRiskStatement(statement: string) {
  const normalized = normalizeStatementForGuard(statement);
  if (!normalized) return false;

  if (
    normalized.startsWith("DROP ") ||
    normalized.startsWith("TRUNCATE ") ||
    normalized.startsWith("GRANT ") ||
    normalized.startsWith("REVOKE ") ||
    normalized.startsWith("ALTER USER ") ||
    normalized.startsWith("CREATE USER ") ||
    normalized.startsWith("DROP USER ")
  ) {
    return true;
  }

  if (normalized.startsWith("DELETE ") && !normalized.includes(" WHERE ")) {
    return true;
  }

  if (normalized.startsWith("UPDATE ") && !normalized.includes(" WHERE ")) {
    return true;
  }

  return false;
}

function isTrustedInlineCompletionConnection(connection?: ConnectionConfig) {
  if (!connection) return false;
  if (connection.db_type === "sqlite") return true;

  const normalizedHost = (connection.host || "").trim().toLowerCase();
  return (
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "localhost" ||
    normalizedHost === "::1" ||
    normalizedHost === "[::1]"
  );
}

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
}: Props) {
  const executeSandboxQuery = useAppStore((state) => state.executeSandboxQuery);
  const switchDatabase = useAppStore((state) => state.switchDatabase);
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

        const activeConnection = useAppStore
          .getState()
          .connections
          .find((connection) => connection.id === connectionId);
        if (!isTrustedInlineCompletionConnection(activeConnection)) {
          return { items: [] };
        }

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

        const today = new Date().toDateString();
        if (dailyInlineCompletionRef.current.date !== today) {
          dailyInlineCompletionRef.current = { count: 0, date: today };
        }
        if (dailyInlineCompletionRef.current.count >= MAX_DAILY_INLINE_COMPLETIONS) {
          return { items: [] };
        }

        lastInlineCompletionAtRef.current = Date.now();
        dailyInlineCompletionRef.current.count += 1;

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
            .askAI(prompt, dbContext, "inline")
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
          devLogError("AI Completion error", e);
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
        } catch (error) {
          setError(formatExecutionError(error));
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
      if (
        targetDatabaseFromUse &&
        activeDatabase !== targetDatabaseFromUse
      ) {
        await switchDatabase(connectionId, targetDatabaseFromUse);
      }

      if (hasHighRiskStatements) {
        const confirmed = window.confirm(
          "Sandbox gateway detected a high-risk SQL statement. TableR will send it through the protected execution boundary and it will apply real changes to the database. Continue?"
        );
        if (!confirmed) {
          return;
        }
      } else if (hasMutatingStatements) {
        const confirmed = window.confirm(
          "Sandbox gateway will apply these SQL changes to the database for real after policy checks. Continue?"
        );
        if (!confirmed) {
          return;
        }
      }

      const queryResult = await executeSandboxQuery(connectionId, statementsToExecute);
      setResult(queryResult);

      setQueryCount((c) => c + 1);
      if (hasMutatingStatements) {
        const invalidateStructure = statementsToExecute.some((statement) => {
          const normalized = normalizeStatementForGuard(statement);
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
            detail: {
              connectionId,
              database: useAppStore.getState().currentDatabase || undefined,
              invalidateStructure,
            },
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
        ? result.sandboxed
          ? "Sandbox"
          : "Write"
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
    });
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
    return () => {
      flushPersistedContent();
      inlineCompletionDisposableRef.current?.dispose();
      completionDisposableRef.current?.dispose();
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
    return () => {
      window.removeEventListener("toggle-query-results-pane", handleToggleResultsPane);
    };
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

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex flex-col min-h-0">
        <div
          className="relative overflow-hidden"
          style={{ height: showResultsPane ? `${editorHeight}%` : "100%", minHeight: 96 }}
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

        {showResultsPane && (
          <>
            <div
              ref={splitRef}
              className="h-[6px] flex-shrink-0 cursor-row-resize group flex items-center justify-center bg-[rgba(255,255,255,0.02)] border-y border-[var(--border-color)] hover:bg-[var(--accent-dim)] transition-colors"
              onMouseDown={handleSplitDrag}
            >
              <div className="w-9 h-[2px] rounded-md bg-[var(--text-muted)]/30 group-hover:bg-[var(--accent)]/60 transition-colors" />
            </div>

            <div className="flex-1 min-h-0 overflow-hidden">
              {error ? (
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
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

