import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, Image as ImageIcon, Loader2, Trash2, X } from "lucide-react";
import { invokeMutation } from "../../utils/tauri-utils";
import { fetchAttachmentDataUrl, formatAttachmentBytes } from "../../utils/ai-attachments";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";

interface AIAttachmentManagerRow {
  id: string;
  workspaceKey: string;
  threadId: string;
  kind: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
}

type ManagerFilter = "all" | "image" | "text";

interface AIAttachmentManagerProps {
  open: boolean;
  copy: AIWorkspaceCopy;
  onClose: () => void;
}

function groupKeyForTimestamp(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function groupLabel(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Manager for stored chat attachments. Rendered through a portal on
 * document.body so panel-level styles (pointer-events, transforms) can never
 * swallow its interactions. Layout mirrors the Provider Settings modal:
 * filter sidebar on the left, grouped detail pane on the right.
 */
export function AIAttachmentManager({ open, copy, onClose }: AIAttachmentManagerProps) {
  const [rows, setRows] = useState<AIAttachmentManagerRow[] | null>(null);
  const [filter, setFilter] = useState<ManagerFilter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBusy, setIsBusy] = useState(false);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setIsBusy(true);
    try {
      const list = await invokeMutation<AIAttachmentManagerRow[]>("list_ai_attachments", {});
      setRows(Array.isArray(list) ? list : []);
      setSelectedIds(new Set());
    } catch (error) {
      console.error("[AIWorkspace] Failed to list attachments:", error);
      setRows([]);
    } finally {
      setIsBusy(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const allRows = rows ?? [];
  const imageCount = allRows.filter((row) => row.kind === "image").length;
  const fileCount = allRows.length - imageCount;

  const visibleRows = useMemo(() => {
    if (!rows) return [];
    return rows.filter((row) => {
      if (filter === "image") return row.kind === "image";
      if (filter === "text") return row.kind !== "image";
      return true;
    });
  }, [filter, rows]);

  // Lazily fetch image payloads so the list stays light (metadata only).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    visibleRows
      .filter((row) => row.kind === "image" && !thumbnailUrls[row.id])
      .slice(0, 24)
      .forEach((row) => {
        void fetchAttachmentDataUrl(row.id).then((dataUrl) => {
          if (!cancelled && dataUrl) {
            setThumbnailUrls((current) => ({ ...current, [row.id]: dataUrl }));
          }
        });
      });
    return () => {
      cancelled = true;
    };
  }, [open, visibleRows, thumbnailUrls]);

  const deleteSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setIsBusy(true);
    try {
      await invokeMutation("delete_ai_attachments", { ids: [...selectedIds] });
      await refresh();
    } catch (error) {
      console.error("[AIWorkspace] Failed to delete attachments:", error);
      setIsBusy(false);
    }
  }, [refresh, selectedIds]);

  const deleteAll = useCallback(async () => {
    if (!window.confirm(copy.attachments.managerDeleteAllConfirm)) return;
    setIsBusy(true);
    try {
      await invokeMutation("delete_all_ai_attachments", {});
      await refresh();
    } catch (error) {
      console.error("[AIWorkspace] Failed to delete attachments:", error);
      setIsBusy(false);
    }
  }, [copy.attachments.managerDeleteAllConfirm, refresh]);

  if (!open) return null;

  const totalSize = allRows.reduce((sum, row) => sum + (row.size || 0), 0);
  const grouped = new Map<string, AIAttachmentManagerRow[]>();
  visibleRows.forEach((row) => {
    const key = groupKeyForTimestamp(row.createdAt);
    const collection = grouped.get(key) || [];
    collection.push(row);
    grouped.set(key, collection);
  });

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filterItems: { value: ManagerFilter; label: string; count: number }[] = [
    { value: "all", label: copy.attachments.managerFilterAll, count: allRows.length },
    { value: "image", label: copy.attachments.managerFilterImages, count: imageCount },
    { value: "text", label: copy.attachments.managerFilterFiles, count: fileCount },
  ];

  return createPortal(
    <div className="ai-settings-overlay" onClick={onClose}>
      <div
        className="ai-settings-modal ai-attachment-manager-modal"
        role="dialog"
        aria-modal="true"
        aria-label={copy.attachments.managerTitle}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ai-settings-header">
          <div className="ai-settings-header-copy">
            <h2 className="ai-settings-title">{copy.attachments.managerTitle}</h2>
            <p className="ai-settings-subtitle">
              {copy.attachments.managerTotalSize}: <strong>{formatAttachmentBytes(totalSize)}</strong>
              {" · "}
              {copy.attachments.managerUsageHint}
            </p>
          </div>
          <div className="ai-settings-header-actions">
            <button
              type="button"
              className="ai-attachment-manager-btn ai-attachment-manager-btn--ghost"
              disabled={isBusy || selectedIds.size === 0}
              onClick={() => void deleteSelected()}
            >
              <Trash2 className="w-3.5 h-3.5" />
              {copy.attachments.managerDeleteSelected}
              {selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
            </button>
            <button
              type="button"
              className="ai-attachment-manager-btn ai-attachment-manager-btn--danger"
              disabled={isBusy || allRows.length === 0}
              onClick={() => void deleteAll()}
            >
              {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              {copy.attachments.managerDeleteAll}
            </button>
            <button type="button" className="ai-settings-btn-cancel" onClick={onClose} aria-label={copy.attachments.managerClose}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        <div className="ai-attachment-manager-layout">
          <aside className="ai-attachment-manager-sidebar">
            <div className="ai-settings-section-label">{copy.attachments.managerFiltersLabel}</div>
            <div className="ai-attachment-manager-nav">
              {filterItems.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`ai-attachment-manager-nav-item ${filter === item.value ? "is-active" : ""}`}
                  onClick={() => setFilter(item.value)}
                >
                  {item.value === "image" ? (
                    <ImageIcon className="w-3.5 h-3.5" />
                  ) : item.value === "text" ? (
                    <FileText className="w-3.5 h-3.5" />
                  ) : null}
                  <span>{item.label}</span>
                  <em>{item.count}</em>
                </button>
              ))}
            </div>
            <div className="ai-settings-section-label ai-attachment-manager-storage-label">
              {copy.attachments.managerStorageLabel}
            </div>
            <div className="ai-attachment-manager-storage">
              <strong>{formatAttachmentBytes(totalSize)}</strong>
              <span>{allRows.length}</span>
            </div>
          </aside>

          <div className="ai-settings-detail ai-attachment-manager-detail">
            {rows === null ? (
              <div className="ai-attachment-manager-empty">
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
            ) : visibleRows.length === 0 ? (
              <div className="ai-settings-empty">
                <h4>{copy.attachments.managerTitle}</h4>
                <p>{copy.attachments.managerEmpty}</p>
              </div>
            ) : (
              [...grouped.entries()].map(([key, group]) => (
                <section key={key} className="ai-attachment-manager-group">
                  <div className="ai-settings-section-label">
                    {groupLabel(group[0].createdAt)}
                  </div>
                  <div className="ai-attachment-manager-group-rows">
                    {group.map((row) => {
                      const isSelected = selectedIds.has(row.id);
                      return (
                        <label key={row.id} className={`ai-attachment-manager-row ${isSelected ? "is-selected" : ""}`}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelected(row.id)}
                          />
                          {row.kind === "image" ? (
                            thumbnailUrls[row.id]
                              ? <img className="ai-attachment-manager-thumb" src={thumbnailUrls[row.id]} alt={row.name} />
                              : <span className="ai-attachment-manager-thumb ai-attachment-manager-thumb--placeholder"><ImageIcon className="w-4 h-4" /></span>
                          ) : (
                            <span className="ai-attachment-manager-thumb ai-attachment-manager-thumb--placeholder"><FileText className="w-4 h-4" /></span>
                          )}
                          <span className="ai-attachment-manager-name" title={row.name}>{row.name}</span>
                          <span className="ai-attachment-manager-size">{formatAttachmentBytes(row.size)}</span>
                        </label>
                      );
                    })}
                  </div>
                </section>
              ))
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
