import {
  Clock,
  Copy,
  Play,
  Search,
  X,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useQueryHistoryStore } from "../../stores/queryHistoryStore";
import type { QueryHistoryEntry } from "../../types";

interface Props {
  isOpen: boolean;
  activeConnectionId: string | null;
  onClose: () => void;
  onRunQuery: (sql: string) => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;

  return date.toLocaleDateString();
}

function truncateQuery(sql: string, maxChars = 100): string {
  const compact = sql.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return compact.slice(0, maxChars - 1) + "\u2026";
}

function QueryHistoryEntryRow({
  entry,
  onCopy,
  onRun,
}: {
  entry: QueryHistoryEntry;
  onCopy: (sql: string) => void;
  onRun: (sql: string) => void;
}) {
  const hasError = !!entry.error;
  const preview = truncateQuery(entry.query_text);

  return (
    <div className="qh-entry" title={entry.query_text}>
      <div className="qh-entry-header">
        <span className="qh-entry-timestamp">
          <Clock className="w-3 h-3" />
          {formatTimestamp(entry.executed_at)}
        </span>
        <span className="qh-entry-duration">{formatDuration(entry.duration_ms)}</span>
        {entry.row_count !== undefined && entry.row_count !== null && (
          <span className="qh-entry-rowcount">{entry.row_count} rows</span>
        )}
        {hasError ? (
          <span className="qh-entry-status error">
            <AlertCircle className="w-3 h-3" />
            Error
          </span>
        ) : (
          <span className="qh-entry-status success">
            <CheckCircle2 className="w-3 h-3" />
            OK
          </span>
        )}
        {entry.database && (
          <span className="qh-entry-database">{entry.database}</span>
        )}
      </div>
      <pre className="qh-entry-query">{preview}</pre>
      <div className="qh-entry-actions">
        <button
          type="button"
          className="qh-action-btn"
          onClick={() => onCopy(entry.query_text)}
          title="Copy query"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          className="qh-action-btn primary"
          onClick={() => onRun(entry.query_text)}
          title="Run query"
        >
          <Play className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

export function QueryHistoryPanel({
  isOpen,
  activeConnectionId,
  onClose,
  onRunQuery,
}: Props) {
  const { entries, isLoading, loadHistory } = useQueryHistoryStore();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce search
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  // Load history when panel opens or connection/search changes
  useEffect(() => {
    if (!isOpen) return;
    void loadHistory(activeConnectionId ?? undefined, debouncedSearch || undefined, 500);
  }, [isOpen, activeConnectionId, debouncedSearch, loadHistory]);

  // Keyboard shortcut: Ctrl+H is used to toggle the panel (handled in AppKeyboardHandler)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleCopy = useCallback(async (sql: string) => {
    try {
      await navigator.clipboard.writeText(sql);
    } catch {
      console.error("Failed to copy to clipboard");
    }
  }, []);

  const handleRun = useCallback((sql: string) => {
    onRunQuery(sql);
  }, [onRunQuery]);

  if (!isOpen) return null;

  return (
    <div className="qh-overlay">
      <aside className="qh-panel">
        <div className="qh-panel-header">
          <div className="qh-panel-title">
            <Clock className="w-4 h-4" />
            <span>Query History</span>
          </div>
          <button type="button" className="qh-close-btn" onClick={onClose}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="qh-search-bar">
          <Search className="w-3.5 h-3.5 qh-search-icon" />
          <input
            type="text"
            className="qh-search-input"
            placeholder="Search queries..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          {search && (
            <button
              type="button"
              className="qh-search-clear"
              onClick={() => setSearch("")}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <div className="qh-list">
          {isLoading ? (
            <div className="qh-empty">Loading...</div>
          ) : entries.length === 0 ? (
            <div className="qh-empty">
              {debouncedSearch
                ? "No matching queries found."
                : "No query history yet. Run a query to see it here."}
            </div>
          ) : (
            entries.map((entry) => (
              <QueryHistoryEntryRow
                key={entry.id}
                entry={entry}
                onCopy={handleCopy}
                onRun={handleRun}
              />
            ))
          )}
        </div>
      </aside>
    </div>
  );
}
