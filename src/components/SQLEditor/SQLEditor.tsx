import Editor from "@monaco-editor/react";
import "../../utils/monaco-bundle";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSQLEditor } from "./hooks/use-sql-editor";
import type { QueryEditorSessionState, QueryChromeState } from "./hooks/use-sql-editor";
import { SQLEditorResultsPane } from "./SQLEditorResultsPane";
import { AlignLeft, Keyboard, Terminal, GitBranch, Loader2, Eye, EyeOff } from "lucide-react";
import { useI18n } from "../../i18n";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorPreferencesStore } from "../../stores/editorPreferencesStore";
import { getQueryProfile } from "../../utils/query-profile";
import { ExplainVisualizer } from "../ExplainVisualizer/ExplainVisualizer";
import { SQLParametersPanel } from "./SQLParametersPanel";
import { extractNamedSqlParameters, type SqlParameterDraft } from "../../utils/sql-parameters";

interface Props {
  connectionId: string;
  initialContent?: string;
  initialCursor?: { lineNumber: number; column: number };
  tabId?: string;
  /** Origin of the owning tab ("ai" tabs honor the full-autonomy grant). */
  tabSource?: "ai" | "user";
  initialState?: QueryEditorSessionState;
  runRequestNonce?: number;
  onChromeChange?: (state: QueryChromeState) => void;
  onStateChange?: (state: QueryEditorSessionState) => void;
}

export function SQLEditor({
  connectionId,
  initialContent = "",
  initialCursor,
  tabId,
  tabSource,
  initialState,
  runRequestNonce = 0,
  onChromeChange,
  onStateChange,
}: Props) {
  const { t, language } = useI18n();
  const vimStatusRef = useRef<HTMLDivElement | null>(null);
  const emergencyDraftKey = `tabler.editor-draft.${connectionId}.${tabId ?? "scratch"}`;
  const restoredContent = useMemo(() => {
    try {
      return window.localStorage.getItem(emergencyDraftKey) ?? initialContent;
    } catch {
      return initialContent;
    }
  }, [emergencyDraftKey, initialContent]);
  const [draftSql, setDraftSql] = useState(restoredContent);
  const parameterStorageKey = `tabler.sql-parameters.${connectionId}.${tabId ?? "scratch"}`;
  const [parameterDrafts, setParameterDrafts] = useState<Record<string, SqlParameterDraft>>(() => {
    try {
      return JSON.parse(window.localStorage.getItem(parameterStorageKey) ?? "{}");
    } catch {
      return {};
    }
  });
  const parameterNames = useMemo(() => extractNamedSqlParameters(draftSql), [draftSql]);
  useEffect(() => {
    window.localStorage.setItem(parameterStorageKey, JSON.stringify(parameterDrafts));
  }, [parameterDrafts, parameterStorageKey]);
  const toggleResultsTitle =
    language === "vi" ? "Bat/tat vung ket qua (Ctrl+Shift+`)" : "Toggle results pane (Ctrl+Shift+`)";
  const vimModeEnabled = useEditorPreferencesStore((state) => state.vimModeEnabled);
  const toggleVimMode = useEditorPreferencesStore((state) => state.toggleVimMode);
  const toolsStorageKey = "tabler.editor-floating-tools-visible";
  const [toolsVisible, setToolsVisible] = useState(() => {
    try {
      return window.localStorage.getItem(toolsStorageKey) !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(toolsStorageKey, toolsVisible ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, [toolsVisible]);
  const toggleToolsTitle = language === "vi"
    ? toolsVisible ? "Ẩn thanh công cụ" : "Hiện thanh công cụ"
    : toolsVisible ? "Hide toolbar" : "Show toolbar";
  const connections = useConnectionStore((state) => state.connections);
  const dbType = connections.find((connection) => connection.id === connectionId)?.db_type;
  const queryProfile = getQueryProfile(dbType);
  const {
    result,
    error,
    notice,
    editorHeight,
    showResultsPane,
    setShowResultsPane,
    resultViewMode,
    setResultViewMode,
    splitRef,
    handleEditorMount,
    handleSplitDrag,
    handleFormatSql,
    schedulePersistedContent,
    explainPlan,
    isRunningExplain,
    handleExplain,
    setExplainPlan,
    aiProposal,
    acceptAiProposal,
    rejectAiProposal,
    notifyManualEditorChange,
  } = useSQLEditor({
    connectionId,
    tabId,
    tabSource,
    initialContent: restoredContent,
    initialCursor,
    vimStatusRef,
    initialState,
    runRequestNonce,
    onChromeChange,
    onStateChange,
    parameterDrafts,
  });

  return (
    <div className="sql-editor-shell" data-testid="sql-editor">
      <div className="sql-editor-stack">
        <div
          className="sql-editor-pane"
          style={{ height: showResultsPane ? `${editorHeight}%` : "100%", minHeight: 96 }}
        >
          {aiProposal ? (
            <div
              role="status"
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
                padding: "6px 10px",
                margin: "0 0 6px",
                border: "1px solid #3b82f6",
                borderRadius: 6,
                background: "rgba(59, 130, 246, 0.12)",
                color: "#dbeafe",
                fontSize: 12,
              }}
            >
              <span
                style={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                AI edit proposal: {aiProposal.reason}
              </span>
              <button
                type="button"
                onClick={acceptAiProposal}
                className="sql-editor-tool-btn"
                style={{ color: "#86efac" }}
              >
                Accept
              </button>
              <button
                type="button"
                onClick={rejectAiProposal}
                className="sql-editor-tool-btn"
                style={{ color: "#fca5a5" }}
              >
                Reject
              </button>
            </div>
          ) : null}
          <Editor
            defaultLanguage={queryProfile.editorLanguage}
            defaultValue={restoredContent}
            theme="vs-dark"
            onChange={(value) => {
              if (value === undefined) return;
              setDraftSql(value);
              notifyManualEditorChange();
              if (tabId) schedulePersistedContent(value);
            }}
            onMount={handleEditorMount}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
              lineNumbers: "on",
              lineNumbersMinChars: 3,
              lineDecorationsWidth: 8,
              glyphMargin: false,
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
              maxTokenizationLineLength: 10000,
              scrollbar: { verticalScrollbarSize: 7, horizontalScrollbarSize: 7 },
            }}
          />
          <SQLParametersPanel
            names={parameterNames}
            drafts={parameterDrafts}
            onChange={(name, next) => setParameterDrafts((current) => ({ ...current, [name]: next }))}
          />
          <div className={`sql-editor-floating-tools ${toolsVisible ? "" : "collapsed"}`}>
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

            <button
              type="button"
              onClick={() => setToolsVisible((current) => !current)}
              title={toggleToolsTitle}
              aria-label={toggleToolsTitle}
              aria-expanded={toolsVisible}
              className="sql-editor-tool-btn icon-only sql-editor-tools-toggle"
            >
              {toolsVisible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
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
          resultViewMode={resultViewMode}
          onResultViewModeChange={setResultViewMode}
          showResultsPane={showResultsPane}
          splitRef={splitRef}
          onSplitDrag={handleSplitDrag}
          onToggleResultsPane={() => setShowResultsPane((current) => !current)}
        />
      </div>
    </div>
  );
}
