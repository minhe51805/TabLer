import Editor, { type OnMount } from "@monaco-editor/react";
import "../../../utils/monaco-bundle";
import type * as Monaco from "monaco-editor";
import { History, Play, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnectionStore } from "../../../stores/connectionStore";
import type { MetricsWidgetDefinition, MetricsWidgetType } from "../../../types";
import {
  executeMetricsQuery,
  formatExecutionError,
  getMetricsRefreshSelectOptions,
  getMetricsSizeSelectOptions,
  getWidgetLibrary,
  pushQueryHistory,
  readQueryHistory,
  validateMetricsQuery,
} from "../utils/query-builder";
import { MetricsCompactSelect } from "./MetricsCompactSelect";
import { useI18n } from "../../../i18n";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetricsEditorProps {
  editingWidget: MetricsWidgetDefinition;
  connectionId: string;
  widgetEditorLayout: {
    left: number;
    top: number;
    width: number;
    height: number;
    side: "left" | "right";
  } | null;
  onQueryDraftChange: (value: string) => void;
  onUpdateWidget: (updates: Partial<MetricsWidgetDefinition>) => void;
  onClearSelection: () => void;
  onDelete: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MetricsEditor({
  editingWidget,
  connectionId,
  widgetEditorLayout,
  onQueryDraftChange,
  onUpdateWidget,
  onClearSelection,
  onDelete,
}: MetricsEditorProps) {
  const { t } = useI18n();
  const metricsEditorCompletionRef = useRef<{ dispose: () => void } | null>(null);
  const tables = useConnectionStore((state) => state.tables);
  const metricsRefreshOptions = getMetricsRefreshSelectOptions();
  const metricsSizeOptions = getMetricsSizeSelectOptions();
  const [preview, setPreview] = useState<{
    loading: boolean;
    result: { columns: string[]; rows: (string | number | boolean | null)[][] } | null;
    error: string | null;
  }>({ loading: false, result: null, error: null });
  const [showHistory, setShowHistory] = useState(false);
  const history = readQueryHistory(connectionId);

  const runPreview = useCallback(async () => {
    const query = editingWidget.query;
    const validation = validateMetricsQuery(query);
    if (!validation.ok) {
      setPreview({ loading: false, result: null, error: validation.error });
      return;
    }
    setPreview({ loading: true, result: null, error: null });
    try {
      const result = await executeMetricsQuery(connectionId, validation.statement);
      pushQueryHistory(connectionId, query);
      setPreview({
        loading: false,
        result: {
          columns: result.columns.map((c) => c.name),
          rows: result.rows.slice(0, 5) as (string | number | boolean | null)[][],
        },
        error: null,
      });
    } catch (error) {
      setPreview({ loading: false, result: null, error: formatExecutionError(error) });
    }
  }, [connectionId, editingWidget.query]);

  useEffect(() => {
    onQueryDraftChange(editingWidget?.query ?? "");
  }, [editingWidget.id, editingWidget?.query, onQueryDraftChange]);

  const handleMetricsEditorMount: OnMount = (editor, monaco) => {
    metricsEditorCompletionRef.current?.dispose();

    metricsEditorCompletionRef.current = monaco.languages.registerCompletionItemProvider("sql", {
      provideCompletionItems: (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        const tableSuggestions = tables.map((table) => ({
          label: table.name,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: table.name,
          detail: "Table",
          range,
        }));

        const keywords = [
          "SELECT",
          "FROM",
          "WHERE",
          "AND",
          "OR",
          "ORDER BY",
          "GROUP BY",
          "LIMIT",
          "JOIN",
          "LEFT JOIN",
          "INNER JOIN",
          "ON",
          "AS",
          "INSERT INTO",
          "VALUES",
          "UPDATE",
          "SET",
          "DELETE FROM",
          "WITH",
          "SHOW",
          "DESCRIBE",
          "EXPLAIN",
        ];

        const keywordSuggestions = keywords.map((keyword) => ({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          detail: "Keyword",
          range,
        }));

        return {
          suggestions: [...tableSuggestions, ...keywordSuggestions],
        };
      },
    });

    monaco.editor.defineTheme("tabler-metrics-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "keyword", foreground: "22D3EE", fontStyle: "bold" },
        { token: "string", foreground: "7FE0C2" },
        { token: "number", foreground: "7DC9D8" },
        { token: "comment", foreground: "65789A", fontStyle: "italic" },
      ],
      colors: {
        "editor.background": "#161d27",
        "editor.foreground": "#e7ecf8",
        "editor.selectionBackground": "#22d3ee2a",
        "editor.lineHighlightBackground": "#0b2f3c66",
        "editorCursor.foreground": "#22d3ee",
        "editorLineNumber.foreground": "#62779d",
        "editorLineNumber.activeForeground": "#e7ecf8",
      },
    });

    editor.updateOptions({ theme: "tabler-metrics-dark" });
  };

  useEffect(() => {
    return () => {
      metricsEditorCompletionRef.current?.dispose();
      metricsEditorCompletionRef.current = null;
    };
  }, []);

  if (!widgetEditorLayout) return null;

  return (
    <div
      className={`metrics-widget-editor metrics-widget-editor-${widgetEditorLayout.side}`}
      style={{
        left: `${widgetEditorLayout.left}px`,
        top: `${widgetEditorLayout.top}px`,
        width: `${widgetEditorLayout.width}px`,
      }}
    >
      <div className="metrics-widget-editor-head">
        <div className="metrics-widget-editor-copy">
          <span className="metrics-widget-editor-kicker">{t("metrics.editor.kicker")}</span>
          <strong className="metrics-widget-editor-title">{editingWidget.title}</strong>
        </div>
      </div>

      <label className="metrics-board-field">
        <span>{t("common.label")}</span>
        <input
          value={editingWidget.title}
          onChange={(event) => onUpdateWidget({ title: event.target.value })}
        />
      </label>

      <label className="metrics-board-field">
        <span>{t("metrics.editor.note")}</span>
        <input
          value={editingWidget.note ?? ""}
          onChange={(event) => onUpdateWidget({ note: event.target.value || undefined })}
          placeholder={t("metrics.editor.notePlaceholder")}
        />
      </label>

      <div className="metrics-board-field">
        <span>{t("metrics.editor.color")}</span>
        <div className="metrics-widget-color-grid">
          {["", "#22d3ee", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#f472b6", "#94a3b8"].map(
            (c) => (
              <button
                key={c || "default"}
                type="button"
                className={`metrics-widget-color-option ${editingWidget.color === c || (!editingWidget.color && !c) ? "is-active" : ""}`}
                style={c ? { backgroundColor: c } : undefined}
                onClick={() => onUpdateWidget({ color: c || undefined })}
                title={c || t("metrics.editor.colorDefault")}
              >
                {!c && <span>×</span>}
              </button>
            ),
          )}
        </div>
      </div>

      <div className="metrics-board-field">
        <span>{t("metrics.editor.widgetType")}</span>
        <div className="metrics-widget-type-grid">
          {getWidgetLibrary().map((item) => (
            <button
              key={item.type}
              type="button"
              className={`metrics-widget-type-option ${editingWidget.type === item.type ? "is-active" : ""}`}
              onClick={() => onUpdateWidget({ type: item.type as MetricsWidgetType })}
              title={item.label}
            >
              <item.icon className="w-3.5 h-3.5" />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="metrics-board-field">
        <span>{t("common.query")}</span>
        <div className="metrics-query-editor">
          <Editor
            key={editingWidget.id}
            height="164px"
            defaultLanguage="sql"
            theme="tabler-metrics-dark"
            defaultValue={editingWidget.query}
            onChange={(value) => onQueryDraftChange(value ?? "")}
            onMount={handleMetricsEditorMount}
            options={{
              readOnly: false,
              domReadOnly: false,
              minimap: { enabled: false },
              lineNumbers: "off",
              glyphMargin: false,
              folding: false,
              lineDecorationsWidth: 0,
              lineNumbersMinChars: 0,
              overviewRulerBorder: false,
              hideCursorInOverviewRuler: true,
              contextmenu: true,
              scrollBeyondLastLine: false,
              wordWrap: "on",
              quickSuggestions: {
                other: true,
                comments: false,
                strings: false,
              },
              suggestOnTriggerCharacters: true,
              acceptSuggestionOnEnter: "on",
              tabSize: 2,
              automaticLayout: true,
              padding: { top: 10, bottom: 10 },
              scrollbar: {
                horizontal: "hidden",
                horizontalScrollbarSize: 0,
                verticalScrollbarSize: 8,
                alwaysConsumeMouseWheel: false,
                useShadows: false,
              },
              scrollBeyondLastColumn: 0,
              fontSize: 12,
              fontFamily: "JetBrains Mono, Consolas, monospace",
            }}
          />
        </div>
      </div>

      <div className="metrics-editor-tools">
        <button
          type="button"
          className="metrics-board-btn"
          onClick={() => void runPreview()}
          disabled={preview.loading}
        >
          <Play className="w-3.5 h-3.5" />
          <span>
            {preview.loading ? t("metrics.editor.previewing") : t("metrics.editor.preview")}
          </span>
        </button>
        {history.length > 0 && (
          <button
            type="button"
            className="metrics-board-btn"
            onClick={() => setShowHistory((v) => !v)}
          >
            <History className="w-3.5 h-3.5" />
            <span>{t("metrics.editor.history")}</span>
          </button>
        )}
      </div>

      {showHistory && (
        <div className="metrics-editor-history">
          {history.map((q, i) => (
            <button
              key={i}
              type="button"
              className="metrics-editor-history-item"
              onClick={() => {
                onQueryDraftChange(q);
                setShowHistory(false);
              }}
              title={q}
            >
              {q.length > 80 ? q.slice(0, 80) + "…" : q}
            </button>
          ))}
        </div>
      )}

      {preview.error && <div className="metrics-editor-preview-error">{preview.error}</div>}
      {preview.result && (
        <div className="metrics-editor-preview">
          <div className="metrics-editor-preview-head">
            <span>{t("metrics.editor.previewResult", { rows: preview.result.rows.length })}</span>
            <button
              type="button"
              onClick={() => setPreview({ loading: false, result: null, error: null })}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <div className="metrics-editor-preview-table">
            <table>
              <thead>
                <tr>
                  {preview.result.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.result.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{cell === null ? "NULL" : String(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="metrics-board-field-grid">
        <label className="metrics-board-field">
          <span>{t("metrics.editor.refreshRate")}</span>
          <MetricsCompactSelect
            value={editingWidget.refresh_seconds}
            options={metricsRefreshOptions}
            ariaLabel={t("metrics.editor.refreshRate")}
            onChange={(nextValue) => onUpdateWidget({ refresh_seconds: Number(nextValue) })}
          />
        </label>

        <label className="metrics-board-field">
          <span>{t("common.size")}</span>
          <MetricsCompactSelect
            value={`${editingWidget.col_span}x${editingWidget.row_span}`}
            options={metricsSizeOptions}
            ariaLabel={t("common.size")}
            onChange={(nextValue) => {
              const [colSpan, rowSpan] = String(nextValue).split("x").map(Number);
              onUpdateWidget({ col_span: colSpan, row_span: rowSpan });
            }}
          />
        </label>
      </div>

      <div className="metrics-board-help compact">{t("metrics.editor.help")}</div>

      <div className="metrics-widget-editor-actions">
        <button type="button" className="metrics-board-btn danger" onClick={onDelete}>
          <Trash2 className="w-3.5 h-3.5" />
          <span>{t("common.delete")}</span>
        </button>
        <button type="button" className="metrics-board-btn" onClick={onClearSelection}>
          <span>{t("common.ok")}</span>
        </button>
      </div>
    </div>
  );
}
