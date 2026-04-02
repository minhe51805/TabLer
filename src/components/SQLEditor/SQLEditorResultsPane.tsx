import { AlertCircle, Terminal, X } from "lucide-react";
import { DataGrid } from "../DataGrid";
import type { QueryResult } from "../../types";
import { useI18n } from "../../i18n";

interface SQLEditorResultsPaneProps {
  error: string | null;
  notice: string | null;
  result: QueryResult | null;
  connectionId: string;
  showResultsPane: boolean;
  splitRef: React.RefObject<HTMLDivElement | null>;
  onSplitDrag: (e: React.MouseEvent) => void;
  onToggleResultsPane: () => void;
}

export function SQLEditorResultsPane({
  error,
  notice,
  result,
  connectionId,
  showResultsPane,
  splitRef,
  onSplitDrag,
  onToggleResultsPane,
}: SQLEditorResultsPaneProps) {
  const { t } = useI18n();

  if (!showResultsPane) return null;

  return (
    <>
      <div
        ref={splitRef}
        className="sql-results-resize"
        onMouseDown={onSplitDrag}
      >
        <div className="sql-results-resize-grip" />
      </div>

      <div className="sql-results-shell">
        <div className="sql-results-header">
          <div className="sql-results-header-meta">
            <Terminal className="w-3.5 h-3.5 text-[var(--fintech-green)]" />
            <span>{t("tabs.results")}</span>
            <kbd className="kbd">Ctrl+Shift+`</kbd>
          </div>

          <button
            type="button"
            onClick={onToggleResultsPane}
            title={t("tabs.hideResults")}
            aria-label={t("tabs.hideResults")}
            className="sql-results-close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="sql-results-body">
          {error ? (
            <div className="sql-results-message is-error">
              <AlertCircle className="sql-results-message-icon h-4 w-4 shrink-0" />
              <div>
                <p className="sql-results-message-title">Execution Error</p>
                <pre className="sql-results-message-body sql-results-message-code">
                  {error}
                </pre>
              </div>
            </div>
          ) : notice ? (
            <div className="sql-results-message">
              <Terminal className="sql-results-message-icon h-4 w-4 shrink-0" />
              <div>
                <p className="sql-results-message-title">{t("tabs.results")}</p>
                <p className="sql-results-message-body">
                  {notice}
                </p>
              </div>
            </div>
          ) : result ? (
            <DataGrid connectionId={connectionId} queryResult={result} />
          ) : (
            <div className="sql-results-empty">
              <Terminal className="h-8 w-8 text-[var(--fintech-green)] opacity-50" />
              <p className="sql-results-empty-copy">
                {t("tabs.readyToExecute")}
              </p>
              <button
                type="button"
                onClick={onToggleResultsPane}
                className="sql-results-empty-action"
              >
                <X className="w-3 h-3" />
                <span>{t("tabs.hideResults")}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
