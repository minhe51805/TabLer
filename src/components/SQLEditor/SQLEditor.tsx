import Editor from "@monaco-editor/react";
import { useRef } from "react";
import { useSQLEditor } from "./hooks/use-sql-editor";
import type { QueryEditorSessionState, QueryChromeState } from "./hooks/use-sql-editor";
import { SQLEditorResultsPane } from "./SQLEditorResultsPane";
import { AlignLeft, Keyboard, Terminal, GitBranch, Loader2 } from "lucide-react";
import { useI18n } from "../../i18n";
import { useAppStore } from "../../stores/appStore";
import { useEditorPreferencesStore } from "../../stores/editorPreferencesStore";
import { getQueryProfile } from "../../utils/query-profile";
import { ExplainVisualizer } from "../ExplainVisualizer/ExplainVisualizer";

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
  const vimStatusRef = useRef<HTMLDivElement | null>(null);
  const toggleResultsTitle =
    language === "vi" ? "Bat/tat vung ket qua (Ctrl+Shift+`)" : "Toggle results pane (Ctrl+Shift+`)";
  const vimModeEnabled = useEditorPreferencesStore((state) => state.vimModeEnabled);
  const toggleVimMode = useEditorPreferencesStore((state) => state.toggleVimMode);
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
    explainPlan,
    isRunningExplain,
    handleExplain,
    setExplainPlan,
  } = useSQLEditor({
    connectionId,
    tabId,
    initialContent,
    vimStatusRef,
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

            <button
              type="button"
              onClick={toggleVimMode}
              title={language === "vi" ? "Bat/tat Vim Mode" : "Toggle Vim Mode"}
              aria-label={language === "vi" ? "Bat/tat Vim Mode" : "Toggle Vim Mode"}
              className={`sql-editor-tool-btn ${vimModeEnabled ? "active" : ""}`}
            >
              <Keyboard className="w-3.5 h-3.5" />
              <span>Vim</span>
            </button>

            <button
              type="button"
              onClick={() => void handleExplain(false)}
              disabled={isRunningExplain}
              title={language === "vi" ? "Xem Query Plan" : "Show EXPLAIN plan"}
              aria-label="EXPLAIN"
              className="sql-editor-tool-btn"
            >
              {isRunningExplain ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <GitBranch className="w-3.5 h-3.5" />
              )}
              <span>EXPLAIN</span>
            </button>
            <div
              ref={vimStatusRef}
              className={`sql-editor-vim-status ${vimModeEnabled ? "visible" : ""}`}
              aria-live="polite"
            />
          </div>
        </div>

        {explainPlan && (
          <ExplainVisualizer
            plan={explainPlan}
            onClose={() => setExplainPlan(undefined)}
          />
        )}

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
        {!showResultsPane && (
          <button
            type="button"
            className="sql-results-collapsed-bar"
            onClick={() => setShowResultsPane(true)}
            title={t("tabs.showResults")}
            aria-label={t("tabs.showResults")}
          >
            <Terminal className="w-3 h-3 opacity-60" />
            <span>{t("tabs.results")}</span>
            <kbd className="kbd kbd-sm">Ctrl+Shift+`</kbd>
          </button>
        )}
      </div>
    </div>
  );
}
