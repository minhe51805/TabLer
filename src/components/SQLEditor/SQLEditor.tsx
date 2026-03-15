import { useState, useRef, useCallback, useEffect } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import {
  Play,
  Loader2,
  Clock,
  AlertCircle,
  Database,
  CheckCircle2,
  Terminal,
  Sparkles,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import type { QueryResult } from "../../types";
import { splitSqlStatements } from "../../utils/sqlStatements";
import { DataGrid } from "../DataGrid";
import { TerminalPanel } from "../TerminalPanel";

interface Props {
  connectionId: string;
  database?: string;
  initialContent?: string;
  tabId?: string;
  onTerminalToggle?: (show: boolean) => void;
}

function formatExecutionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error:\s*/, "");
}

export function SQLEditor({ connectionId, database, initialContent = "", tabId, onTerminalToggle }: Props) {
  const { executeQuery, isExecutingQuery, updateTab } = useAppStore();
  const editorRef = useRef<any>(null);
  const splitRef = useRef<HTMLDivElement>(null);

  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queryCount, setQueryCount] = useState(0);
  const [editorHeight, setEditorHeight] = useState(42);
  const [showTerminal, setShowTerminal] = useState(false);
  const [isBatchExecuting, setIsBatchExecuting] = useState(false);

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
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
      run: () => {
        window.dispatchEvent(new CustomEvent('open-ai-slide-panel'));
      },
    });

    // Add Inline AI Auto-completion provider
    monaco.languages.registerInlineCompletionsProvider("sql", {
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

        try {
          // Fetch light schema (just names) for speed during typing
          const tableNameList = useAppStore.getState().tables.map(t => t.name).join(", ");
          const dbContext = `Database: ${useAppStore.getState().currentDatabase || "Default"}\nAvailable Tables: ${tableNameList}\nProvide ONLY the raw SQL code completion. Do not add quotes, markdown, or explanations.`;

          const prompt = `Complete this SQL query (return only the remaining code):\n${textUntilPosition}`;
          let suggestion = await useAppStore.getState().askAI(activeProvider.id, prompt, dbContext);

          // Strip markdown and leading spaces
          suggestion = suggestion.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```$/i, '').trim();

          // If the AI returns the full query instead of completion, strip the prefix
          if (suggestion.toLowerCase().startsWith(textUntilPosition.trim().toLowerCase())) {
            suggestion = suggestion.slice(textUntilPosition.trim().length).trim();
          }

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
    monaco.languages.registerCompletionItemProvider("sql", {
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
        { token: "keyword", foreground: "9EF0D8", fontStyle: "bold" },
        { token: "string", foreground: "F7C97A" },
        { token: "number", foreground: "FFB285" },
        { token: "comment", foreground: "6F8F86", fontStyle: "italic" },
        { token: "operator", foreground: "8DDFC6" },
      ],
      colors: {
        "editor.background": "#0d181d",
        "editor.foreground": "#e6efe8",
        "editor.selectionBackground": "#78e0c236",
        "editor.lineHighlightBackground": "#17303666",
        "editorCursor.foreground": "#9ef0d8",
        "editorLineNumber.foreground": "#5f8279",
        "editorLineNumber.activeForeground": "#dff3eb",
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
    setIsBatchExecuting(true);
    try {
      if (statements.length === 1) {
        const queryResult = await executeQuery(connectionId, statements[0]);
        setResult(queryResult);
      } else {
        let totalAffectedRows = 0;
        let totalExecutionTimeMs = 0;
        let lastSelectResult: QueryResult | null = null;

        for (const [index, statement] of statements.entries()) {
          try {
            const queryResult = await executeQuery(connectionId, statement);
            totalAffectedRows += queryResult.affected_rows;
            totalExecutionTimeMs += queryResult.execution_time_ms;

            if (queryResult.columns.length > 0) {
              lastSelectResult = queryResult;
            }
          } catch (executionError) {
            throw new Error(
              `Statement ${index + 1}/${statements.length} failed.\n${formatExecutionError(executionError)}`
            );
          }
        }

        setResult(
          lastSelectResult
            ? {
                ...lastSelectResult,
                affected_rows: totalAffectedRows,
                execution_time_ms: totalExecutionTimeMs,
                query: statements.join(";\n"),
              }
            : {
                columns: [],
                rows: [],
                affected_rows: totalAffectedRows,
                execution_time_ms: totalExecutionTimeMs,
                query: statements.join(";\n"),
              }
        );
      }

      setQueryCount((c) => c + 1);
      setShowTerminal(false);
    } catch (e) {
      setError(formatExecutionError(e));
      setResult(null);
    } finally {
      setIsBatchExecuting(false);
    }
  }, [connectionId, executeQuery, isBatchExecuting]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === "`" || key === "j") {
        e.preventDefault();
        setShowTerminal((v) => {
          const newValue = !v;
          if (onTerminalToggle) {
            onTerminalToggle(newValue);
          }
          return newValue;
        });
      }
    };

    const onCloseTerminal = () => {
      setShowTerminal(false);
    };

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

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("close-sql-terminal", onCloseTerminal);
    window.addEventListener("insert-sql-from-ai", onInsertSQLFromAI);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("close-sql-terminal", onCloseTerminal);
      window.removeEventListener("insert-sql-from-ai", onInsertSQLFromAI);
    };
  }, [onTerminalToggle]);

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
      <div className="flex items-center gap-2 px-3 py-2 bg-[rgba(255,255,255,0.02)] border-b border-[var(--border-color)] flex-shrink-0">
        <button
          onClick={handleExecute}
          disabled={isExecutingQuery || isBatchExecuting}
          className="btn btn-primary flex items-center gap-1.5"
          title="Execute (Ctrl+Enter)"
        >
          {isExecutingQuery || isBatchExecuting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Play className="w-3.5 h-3.5" />
          )}
          Run
        </button>

        <button
          onClick={() => {
            setShowTerminal((v) => {
              const newValue = !v;
              if (onTerminalToggle) {
                onTerminalToggle(newValue);
              }
              return newValue;
            });
          }}
          className="btn btn-secondary flex items-center gap-1.5"
          title="Toggle Terminal (Ctrl+J)"
        >
          <Terminal className="w-3.5 h-3.5" />
          Terminal
        </button>

        <button
          onClick={() => window.dispatchEvent(new CustomEvent('open-ai-slide-panel'))}
          className="btn btn-secondary flex items-center gap-1.5 border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/10"
          title="Ask AI for SQL (Ctrl+Shift+K)"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Ask AI
        </button>

        {database && (
          <span className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] ml-1 px-2 py-1 bg-[rgba(255,255,255,0.03)] border border-white/10 rounded-md">
            <Database className="w-3 h-3 text-[var(--accent)]" />
            {database}
          </span>
        )}

        {result && (
          <div className="flex items-center gap-3 ml-auto text-[11px]">
            <span className="flex items-center gap-1 text-[var(--success)]">
              <CheckCircle2 className="w-3 h-3" />
              Success
            </span>
            <span className="flex items-center gap-1 text-[var(--text-muted)]">
              <Clock className="w-3 h-3" />
              {result.execution_time_ms}ms
            </span>
            {result.rows.length > 0 && (
              <span className="text-[var(--text-secondary)] tabular-nums">
                {result.rows.length} row{result.rows.length !== 1 ? "s" : ""}
              </span>
            )}
            {result.affected_rows > 0 && (
              <span className="text-[var(--warning)] tabular-nums">
                {result.affected_rows} affected
              </span>
            )}
            {queryCount > 1 && (
              <span className="text-[var(--text-muted)] tabular-nums">#{queryCount}</span>
            )}
          </div>
        )}
      </div>

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
                updateTab(tabId, { content: value });
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
          {showTerminal ? (
            <TerminalPanel initialCwd="." />
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
              <p className="text-[11px] opacity-70">
                Press <kbd className="px-1.5 py-0.5 mx-0.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border-color)] text-[10px] font-mono">Ctrl+J</kbd> to open terminal
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
