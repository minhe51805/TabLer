import Editor from "@monaco-editor/react";
import { useSQLEditor } from "./hooks/use-sql-editor";
import type { QueryEditorSessionState, QueryChromeState } from "./hooks/use-sql-editor";
import { SQLEditorResultsPane } from "./SQLEditorResultsPane";
import { AlignLeft } from "lucide-react";

interface Props {
  connectionId: string;
  initialContent?: string;
  tabId?: string;
  initialState?: QueryEditorSessionState;
  runRequestNonce?: number;
  onChromeChange?: (state: QueryChromeState) => void;
  onStateChange?: (state: QueryEditorSessionState) => void;
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
  const {
    result,
    error,
    editorHeight,
    showResultsPane,
    splitRef,
    handleEditorMount,
    handleSplitDrag,
    handleFormatSql,
    schedulePersistedContent,
  } = useSQLEditor({
    connectionId,
    tabId,
    initialContent,
    initialState,
    runRequestNonce,
    onChromeChange,
    onStateChange,
  });

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
              scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            }}
          />
          {/* Format toolbar button */}
          <button
            type="button"
            onClick={handleFormatSql}
            title="Format SQL (Ctrl+Shift+F)"
            className="absolute top-2 right-2 z-10 p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors"
          >
            <AlignLeft className="w-3.5 h-3.5" />
          </button>
        </div>

        <SQLEditorResultsPane
          error={error}
          result={result}
          connectionId={connectionId}
          showResultsPane={showResultsPane}
          splitRef={splitRef}
          onSplitDrag={handleSplitDrag}
        />
      </div>
    </div>
  );
}
