import {
  AlertCircle,
  CheckCircle2,
  CheckSquare,
  Clock,
  Copy,
  Play,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { useEvent } from "../../stores/event-center";
import { useQueryHistoryStore } from "../../stores/queryHistoryStore";
import type { QueryHistoryEntry } from "../../types";
import "../../styles/lazy-overlays.css";

interface Props {
  isOpen: boolean;
  activeConnectionId: string | null;
  onClose: () => void;
  onRunQuery: (sql: string) => void;
}

interface QueryHistoryDayGroup {
  key: string;
  label: string;
  entries: QueryHistoryEntry[];
}

import {
  formatDuration,
  formatTimestamp,
  getDayKey,
  getDayLabel,
  getHistoryCopy,
  truncateQuery,
} from "./query-history-utils";

export function QueryHistoryEntryRow({
  copy,
  entry,
  isSelected,
  onCopy,
  onDelete,
  onRun,
  onToggleSelected,
}: {
  copy: ReturnType<typeof getHistoryCopy>;
  entry: QueryHistoryEntry;
  isSelected: boolean;
  onCopy: (sql: string) => void;
  onDelete: (entry: QueryHistoryEntry) => void;
  onRun: (sql: string) => void;
  onToggleSelected: (entry: QueryHistoryEntry) => void;
}) {
  const hasError = !!entry.error;
  const preview = truncateQuery(entry.query_text);

  return (
    <div className={`qh-entry ${isSelected ? "is-selected" : ""}`} title={entry.query_text}>
      <div className="qh-entry-header">
        {typeof entry.id === "number" && (
          <button
            type="button"
            className={`qh-select-btn ${isSelected ? "is-selected" : ""}`}
            onClick={() => onToggleSelected(entry)}
            title={isSelected ? "Deselect" : "Select"}
          >
            {isSelected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
          </button>
        )}
        <span className="qh-entry-timestamp">
          <Clock className="w-3 h-3" />
          {formatTimestamp(entry.executed_at)}
        </span>
        <span className="qh-entry-duration">{formatDuration(entry.duration_ms)}</span>
        {entry.row_count !== undefined && entry.row_count !== null && (
          <span className="qh-entry-rowcount">
            {entry.row_count} {copy.rows}
          </span>
        )}
        {hasError ? (
          <span className="qh-entry-status error">
            <AlertCircle className="w-3 h-3" />
            Error
          </span>
        ) : (
          <span className="qh-entry-status success">
            <CheckCircle2 className="w-3 h-3" />
            {copy.ok}
          </span>
        )}
        {entry.database && <span className="qh-entry-database">{entry.database}</span>}
      </div>

      <pre className="qh-entry-query">{preview}</pre>

      <div className="qh-entry-actions">
        <button
          type="button"
          className="qh-action-btn"
          onClick={() => onCopy(entry.query_text)}
          title={copy.copyTitle}
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          className="qh-action-btn primary"
          onClick={() => onRun(entry.query_text)}
          title={copy.runTitle}
        >
          <Play className="w-3.5 h-3.5" />
        </button>
        {typeof entry.id === "number" && (
          <button
            type="button"
            className="qh-action-btn danger"
            onClick={() => onDelete(entry)}
            title={copy.deleteTitle}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

export function QueryHistoryPanel({ isOpen, activeConnectionId, onClose, onRunQuery }: Props) {
  const { language } = useI18n();
  const { entries, isLoading, loadHistory, deleteEntries, clearHistory } = useQueryHistoryStore();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  const copy = getHistoryCopy(language, activeConnectionId, selectedIds.length);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!isOpen) return;
    void loadHistory(activeConnectionId ?? undefined, debouncedSearch || undefined, 500);
  }, [activeConnectionId, debouncedSearch, isOpen, loadHistory]);

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => entries.some((entry) => entry.id === id)));
  }, [entries]);

  useEvent(
    "query-history-updated",
    ({ connectionId }) => {
      if (!isOpen) return;
      if (activeConnectionId && connectionId && connectionId !== activeConnectionId) return;
      void loadHistory(activeConnectionId ?? undefined, debouncedSearch || undefined, 500);
    },
    [activeConnectionId, debouncedSearch, isOpen, loadHistory],
  );

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

  const groupedEntries = useMemo<QueryHistoryDayGroup[]>(() => {
    const groups = new Map<string, QueryHistoryDayGroup>();

    for (const entry of entries) {
      const key = getDayKey(entry.executed_at);
      const existing = groups.get(key);
      if (existing) {
        existing.entries.push(entry);
        continue;
      }
      groups.set(key, {
        key,
        label: getDayLabel(entry.executed_at, copy),
        entries: [entry],
      });
    }

    return Array.from(groups.values());
  }, [copy, entries]);

  const visibleSelectableIds = useMemo(
    () =>
      entries
        .map((entry) => entry.id)
        .filter((id): id is number => typeof id === "number"),
    [entries],
  );

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const handleCopy = useCallback(async (sql: string) => {
    try {
      await navigator.clipboard.writeText(sql);
    } catch {
      console.error("Failed to copy to clipboard");
    }
  }, []);

  const handleRun = useCallback(
    (sql: string) => {
      onRunQuery(sql);
    },
    [onRunQuery],
  );

  const handleToggleSelected = useCallback((entry: QueryHistoryEntry) => {
    if (typeof entry.id !== "number") return;
    const entryId = entry.id;
    setSelectedIds((current) =>
      current.includes(entryId) ? current.filter((id) => id !== entryId) : [...current, entryId],
    );
  }, []);

  const handleToggleGroup = useCallback((group: QueryHistoryDayGroup) => {
    const groupIds = group.entries
      .map((entry) => entry.id)
      .filter((id): id is number => typeof id === "number");
    if (!groupIds.length) return;

    setSelectedIds((current) => {
      const allSelected = groupIds.every((id) => current.includes(id));
      if (allSelected) {
        return current.filter((id) => !groupIds.includes(id));
      }

      return Array.from(new Set([...current, ...groupIds]));
    });
  }, []);

  const handleToggleSelectAllVisible = useCallback(() => {
    if (!visibleSelectableIds.length) return;

    setSelectedIds((current) => {
      const allSelected = visibleSelectableIds.every((id) => current.includes(id));
      return allSelected ? [] : visibleSelectableIds;
    });
  }, [visibleSelectableIds]);

  const handleDeleteOne = useCallback(
    async (entry: QueryHistoryEntry) => {
      if (typeof entry.id !== "number") return;
      if (!window.confirm(copy.deleteConfirm)) return;
      await deleteEntries([entry.id], entry.connection_id);
    },
    [copy.deleteConfirm, deleteEntries],
  );

  const handleDeleteSelected = useCallback(async () => {
    if (!selectedIds.length) return;
    if (!window.confirm(copy.deleteSelectedConfirm)) return;
    await deleteEntries(selectedIds, activeConnectionId ?? undefined);
    setSelectedIds([]);
  }, [activeConnectionId, copy.deleteSelectedConfirm, deleteEntries, selectedIds]);

  const handleClearHistory = useCallback(async () => {
    if (!entries.length) return;
    if (!window.confirm(copy.clearConfirm)) return;
    await clearHistory(activeConnectionId ?? undefined);
    setSelectedIds([]);
  }, [activeConnectionId, clearHistory, copy.clearConfirm, entries.length]);

  if (!isOpen) return null;

  return (
    <div className="qh-overlay">
      <aside className="qh-panel">
        <div className="qh-panel-header">
          <div className="qh-panel-title">
            <Clock className="w-4 h-4" />
            <span>{copy.panelTitle}</span>
          </div>

          <div className="qh-panel-actions">
            <button
              type="button"
              className="qh-header-btn"
              onClick={() => void handleClearHistory()}
              disabled={entries.length === 0}
              title={copy.clearTitle}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{copy.clearTitle}</span>
            </button>

            <button type="button" className="qh-close-btn" onClick={onClose}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="qh-search-bar">
          <Search className="w-3.5 h-3.5 qh-search-icon" />
          <input
            type="text"
            className="qh-search-input"
            placeholder={copy.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          {search && (
            <button type="button" className="qh-search-clear" onClick={() => setSearch("")}>
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <div className="qh-toolbar">
          <span className="qh-toolbar-count">{copy.selectedCount}</span>
          <div className="qh-toolbar-actions">
            <button
              type="button"
              className="qh-toolbar-btn"
              onClick={handleToggleSelectAllVisible}
              disabled={visibleSelectableIds.length === 0}
            >
              {copy.selectAllVisible}
            </button>
            <button
              type="button"
              className="qh-toolbar-btn danger"
              onClick={() => void handleDeleteSelected()}
              disabled={selectedIds.length === 0}
            >
              {copy.deleteSelected}
            </button>
          </div>
        </div>

        <div className="qh-list">
          {isLoading ? (
            <div className="qh-empty">{copy.loading}</div>
          ) : groupedEntries.length === 0 ? (
            <div className="qh-empty">{debouncedSearch ? copy.noMatches : copy.noHistory}</div>
          ) : (
            groupedEntries.map((group) => {
              const groupIds = group.entries
                .map((entry) => entry.id)
                .filter((id): id is number => typeof id === "number");
              const selectedInGroup = groupIds.filter((id) => selectedIdSet.has(id)).length;
              const okCount = group.entries.filter((entry) => !entry.error).length;
              const errorCount = group.entries.length - okCount;

              return (
                <section key={group.key} className="qh-group">
                  <div className="qh-group-header">
                    <button
                      type="button"
                      className={`qh-select-btn ${groupIds.length > 0 && selectedInGroup === groupIds.length ? "is-selected" : ""}`}
                      onClick={() => handleToggleGroup(group)}
                      disabled={groupIds.length === 0}
                    >
                      {groupIds.length > 0 && selectedInGroup === groupIds.length ? (
                        <CheckSquare className="w-3.5 h-3.5" />
                      ) : (
                        <Square className="w-3.5 h-3.5" />
                      )}
                    </button>

                    <div className="qh-group-copy">
                      <strong>{group.label}</strong>
                      <span>
                        {group.entries.length} {copy.queries} · {okCount} {copy.ok}
                        {errorCount > 0 ? ` · ${errorCount} ${copy.errors}` : ""}
                      </span>
                    </div>
                  </div>

                  <div className="qh-group-list">
                    {group.entries.map((entry) => (
                      <QueryHistoryEntryRow
                        key={entry.id ?? `${group.key}-${entry.executed_at}-${entry.query_text}`}
                        copy={copy}
                        entry={entry}
                        isSelected={typeof entry.id === "number" && selectedIdSet.has(entry.id)}
                        onCopy={handleCopy}
                        onDelete={handleDeleteOne}
                        onRun={handleRun}
                        onToggleSelected={handleToggleSelected}
                      />
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}
