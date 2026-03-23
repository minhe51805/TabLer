import { AlertCircle, Terminal } from "lucide-react";
import { DataGrid } from "../DataGrid";
import type { QueryResult } from "../../types";

interface SQLEditorResultsPaneProps {
  error: string | null;
  result: QueryResult | null;
  connectionId: string;
  showResultsPane: boolean;
  splitRef: React.RefObject<HTMLDivElement | null>;
  onSplitDrag: (e: React.MouseEvent) => void;
}

export function SQLEditorResultsPane({
  error,
  result,
  connectionId,
  showResultsPane,
  splitRef,
  onSplitDrag,
}: SQLEditorResultsPaneProps) {
  if (!showResultsPane) return null;

  return (
    <>
      <div
        ref={splitRef}
        className="h-[6px] flex-shrink-0 cursor-row-resize group flex items-center justify-center bg-[rgba(255,255,255,0.02)] border-y border-[var(--border-color)] hover:bg-[var(--accent-dim)] transition-colors"
        onMouseDown={onSplitDrag}
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
  );
}
