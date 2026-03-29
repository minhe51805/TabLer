import Editor, { type OnMount } from "@monaco-editor/react";
import { Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAppStore } from "../../../stores/appStore";
import type { MetricsWidgetDefinition } from "../../../types";
import {
  getMetricsRefreshSelectOptions,
  getMetricsSizeSelectOptions,
} from "../utils/query-builder";
import { MetricsCompactSelect } from "./MetricsCompactSelect";
import { useI18n } from "../../../i18n";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetricsEditorProps {
  editingWidget: MetricsWidgetDefinition;
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
  widgetEditorLayout,
  onQueryDraftChange,
  onUpdateWidget,
  onClearSelection,
  onDelete,
}: MetricsEditorProps) {
  const { t } = useI18n();
  const metricsEditorCompletionRef = useRef<{ dispose: () => void } | null>(null);
  const tables = useAppStore((state) => state.tables);
  const metricsRefreshOptions = getMetricsRefreshSelectOptions();
  const metricsSizeOptions = getMetricsSizeSelectOptions();

  useEffect(() => {
    onQueryDraftChange(editingWidget?.query ?? "");
  }, [editingWidget?.id, onQueryDraftChange]);

  const handleMetricsEditorMount: OnMount = (editor, monaco) => {
    metricsEditorCompletionRef.current?.dispose();

    metricsEditorCompletionRef.current = monaco.languages.registerCompletionItemProvider("sql", {
      provideCompletionItems: (model: any, position: any) => {
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
          "SELECT", "FROM", "WHERE", "AND", "OR", "ORDER BY", "GROUP BY",
          "LIMIT", "JOIN", "LEFT JOIN", "INNER JOIN", "ON", "AS",
          "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM",
          "WITH", "SHOW", "DESCRIBE", "EXPLAIN",
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
        { token: "keyword", foreground: "FBBF24", fontStyle: "bold" },
        { token: "string", foreground: "E8BF7A" },
        { token: "number", foreground: "FFB285" },
        { token: "comment", foreground: "65789A", fontStyle: "italic" },
      ],
      colors: {
        "editor.background": "#161d27",
        "editor.foreground": "#e7ecf8",
        "editor.selectionBackground": "#f59e0b36",
        "editor.lineHighlightBackground": "#2d1f0666",
        "editorCursor.foreground": "#fbbf24",
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

      <div className="metrics-board-help compact">
        {t("metrics.editor.help")}
      </div>

      <div className="metrics-widget-editor-actions">
        <button
          type="button"
          className="metrics-board-btn danger"
          onClick={onDelete}
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>{t("common.delete")}</span>
        </button>
        <button
          type="button"
          className="metrics-board-btn"
          onClick={onClearSelection}
        >
          <span>{t("common.ok")}</span>
        </button>
      </div>
    </div>
  );
}
