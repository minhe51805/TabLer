import Editor from "@monaco-editor/react";
import { useSQLEditor } from "./hooks/use-sql-editor";
import type { QueryEditorSessionState, QueryChromeState } from "./hooks/use-sql-editor";
import { SQLEditorResultsPane } from "./SQLEditorResultsPane";
import { AlignLeft, Terminal } from "lucide-react";
import { useI18n } from "../../i18n";
import { useAppStore } from "../../stores/appStore";
import { getQueryProfile } from "../../utils/query-profile";

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
  const { t, language } = useI18n();
  const toggleResultsTitle =
    language === "vi" ? "Bat/tat vung ket qua (Ctrl+Shift+`)" : "Toggle results pane (Ctrl+Shift+`)";
  const connections = useAppStore((state) => state.connections);
  const dbType = connections.find((connection) => connection.id === connectionId)?.db_type;
  const queryProfile = getQueryProfile(dbType);
  const {
    result,
    error,
    notice,
    editorHeight,
    showResultsPane,
    setShowResultsPane,
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
    <div className="sql-editor-shell">
      <div className="sql-editor-stack">
        <div
          className="sql-editor-pane"
          style={{ height: showResultsPane ? `${editorHeight}%` : "100%", minHeight: 96 }}
        >
          <Editor
            defaultLanguage={queryProfile.editorLanguage}
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
              fontSize: 12,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              wordWrap: "on",
              padding: { top: 8, bottom: 6 },
              suggestOnTriggerCharacters: true,
              quickSuggestions: true,
              tabSize: 2,
              renderLineHighlight: "line",
              bracketPairColorization: { enabled: true },
              autoClosingBrackets: "always",
              automaticLayout: true,
              inlineSuggest: { enabled: true },
              scrollbar: { verticalScrollbarSize: 7, horizontalScrollbarSize: 7 },
            }}
          />
          <div className="sql-editor-floating-tools">
            <button
              type="button"
              onClick={() => setShowResultsPane((current) => !current)}
              title={toggleResultsTitle}
              aria-label={showResultsPane ? t("tabs.hideResults") : t("tabs.showResults")}
              className={`sql-editor-tool-btn ${showResultsPane ? "active" : ""}`}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>{t("tabs.results")}</span>
            </button>

            {queryProfile.supportsFormatting && (
              <button
                type="button"
                onClick={handleFormatSql}
                title="Format SQL (Ctrl+Shift+F)"
                className="sql-editor-tool-btn icon-only"
              >
                <AlignLeft className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <SQLEditorResultsPane
          error={error}
          notice={notice}
          result={result}
          connectionId={connectionId}
          showResultsPane={showResultsPane}
          splitRef={splitRef}
          onSplitDrag={handleSplitDrag}
          onToggleResultsPane={() => setShowResultsPane((current) => !current)}
        />
      </div>
    </div>
  );
}
