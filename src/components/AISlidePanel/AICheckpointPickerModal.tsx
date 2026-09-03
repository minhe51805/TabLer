import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { History, Loader2, ShieldAlert, ChevronRight, Trash2, X } from "lucide-react";
import { invokeMutation } from "../../utils/tauri-utils";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";
import {
  setAICheckpointPickerHostMounted,
  type AICheckpointPickRequest,
} from "./ai-checkpoint-picker";
import type { AIDatabaseCheckpoint } from "./ai-slash-commands";

interface RestorePreviewShape {
  statementCount: number;
  schemaChangeCount: number;
  dataChangeCount: number;
  destructiveStatementCount: number;
  transactional: boolean;
  warning?: string | null;
}

interface AICheckpointPickerModalProps {
  copy: AIWorkspaceCopy["composer"];
}

/** Day label for the left rail, e.g. "Sep 3" in the panel language. */
function formatCheckpointDay(epochMs: number, language: string) {
  try {
    return new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : language, {
      month: "short",
      day: "numeric",
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString().slice(0, 10);
  }
}

/** Clock-only label for the right pane meta, e.g. "11:10 AM". */
function formatCheckpointClock(epochMs: number, language: string) {
  try {
    return new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : language, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString().slice(11, 16);
  }
}

/** Group checkpoints by calendar day (newest day first), Provider-Settings rail style. */
function groupCheckpointsByDay(
  checkpoints: AIDatabaseCheckpoint[],
  language: string,
): Record<string, AIDatabaseCheckpoint[]> {
  const groups: Record<string, AIDatabaseCheckpoint[]> = {};
  for (const checkpoint of checkpoints) {
    const key = formatCheckpointDay(checkpoint.createdAt, language);
    (groups[key] ??= []).push(checkpoint);
  }
  return groups;
}

/**
 * Host for the /rollback checkpoint picker. Listens for pick requests and
 * renders list → preview → confirm inside one themed modal; resolves the
 * picked file name through the response event. Cancel (Esc / backdrop /
 * button, cancel auto-focused) resolves null.
 */
export function AICheckpointPickerModal({ copy }: AICheckpointPickerModalProps) {
  const [request, setRequest] = useState<AICheckpointPickRequest | null>(null);
  const [confirming, setConfirming] = useState<AIDatabaseCheckpoint | null>(null);
  const [preview, setPreview] = useState<RestorePreviewShape | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);

  useEffect(() => {
    setAICheckpointPickerHostMounted(true);
    const handleRequest = (event: Event) => {
      setRequest((event as CustomEvent<AICheckpointPickRequest>).detail);
      setConfirming(null);
      setPreview(null);
      setPreviewError(null);
      setSelectedDayKey(null);
    };
    window.addEventListener("ai-checkpoint-pick-request", handleRequest);
    return () => {
      setAICheckpointPickerHostMounted(false);
      window.removeEventListener("ai-checkpoint-pick-request", handleRequest);
    };
  }, []);

  // Esc cancels the pick. Must run before the `!request` early return so the
  // hook order stays stable across renders.
  useEffect(() => {
    if (!request) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      window.dispatchEvent(
        new CustomEvent("ai-checkpoint-pick-response", {
          detail: { id: request.id, fileName: null },
        }),
      );
      setRequest(null);
      setConfirming(null);
      setPreview(null);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [request]);

  if (!request) return null;

  const dayGroups = groupCheckpointsByDay(request.checkpoints, request.language);
  const activeDayKey = selectedDayKey && dayGroups[selectedDayKey] ? selectedDayKey : Object.keys(dayGroups)[0] ?? null;
  const dayCheckpoints = activeDayKey ? dayGroups[activeDayKey]! : [];

  const respond = (fileName: string | null) => {
    window.dispatchEvent(
      new CustomEvent("ai-checkpoint-pick-response", {
        detail: { id: request.id, fileName },
      }),
    );
    setRequest(null);
    setConfirming(null);
    setPreview(null);
  };

  const close = () => respond(null);

  const startConfirm = async (checkpoint: AIDatabaseCheckpoint) => {
    setConfirming(checkpoint);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const result = await invokeMutation<RestorePreviewShape>(
        "preview_database_checkpoint_restore",
        {
          connectionId: request.connectionId,
          fileName: checkpoint.fileName,
          dbType: request.dbType,
        },
      );
      setPreview(result);
    } catch (errorValue) {
      setPreviewError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setPreviewLoading(false);
    }
  };

  const describeCheckpoint = (checkpoint: AIDatabaseCheckpoint) =>
    [
      formatCheckpointClock(checkpoint.createdAt, request.language),
      checkpoint.engine,
      checkpoint.database,
      `${checkpoint.tableCount}T/${checkpoint.rowCount}R`,
    ]
      .filter(Boolean)
      .join(" · ");

  return createPortal(
    <div
      className="ckpt-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className={`ckpt-dialog${confirming ? " ckpt-dialog--danger" : ""}`}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="ckpt-dialog__header">
          <div className="ckpt-dialog__icon">
            {confirming ? <ShieldAlert size={21} /> : <History size={21} />}
          </div>
          <div className="ckpt-dialog__heading">
            <h2 className="ckpt-dialog__title">{copy.checkpointTitle}</h2>
            {!confirming && <p className="ckpt-dialog__subtitle">{copy.checkpointHint}</p>}
          </div>
          <button
            type="button"
            onClick={close}
            className="ckpt-dialog__close"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="ckpt-dialog__body">
          {!confirming ? (
            request.checkpoints.length === 0 ? (
              <div className="ckpt-dialog__empty">
                <History size={22} />
                {copy.checkpointEmpty}
              </div>
            ) : (
              <div className="ckpt-day-grid">
                {/* Left rail: one entry per day (Provider Settings style) */}
                <aside className="ckpt-day-rail">
                  {Object.entries(groupCheckpointsByDay(request.checkpoints, request.language)).map(
                    ([dayKey, dayItems]) => (
                      <button
                        key={dayKey}
                        type="button"
                        className={`ckpt-day-rail__item${selectedDayKey === dayKey ? " is-active" : ""}`}
                        onClick={() => setSelectedDayKey(dayKey)}
                      >
                        <span className="ckpt-day-rail__label">{dayKey}</span>
                        <span className="ckpt-day-rail__count">{dayItems.length}</span>
                      </button>
                    ),
                  )}
                </aside>

                {/* Right pane: checkpoints of the selected day */}
                <div className="ckpt-day-pane">
                  <p className="ckpt-day-pane__title">{selectedDayKey}</p>
                  <ul className="ckpt-list">
                {dayCheckpoints.map((checkpoint) => (
                  <li key={checkpoint.fileName} className="ckpt-item-row">
                    <button
                      type="button"
                      className="ckpt-item"
                      onClick={() => void startConfirm(checkpoint)}
                    >
                      <span className="ckpt-item__icon">
                        <History size={15} />
                      </span>
                      <span className="ckpt-item__main">
                        <span className="ckpt-item__label">{checkpoint.label}</span>
                        <span className="ckpt-item__meta">{describeCheckpoint(checkpoint)}</span>
                      </span>
                      <ChevronRight size={15} className="ckpt-item__chevron" />
                    </button>
                    <button
                      type="button"
                      className={`ckpt-item__delete${deleteConfirmId === checkpoint.fileName ? " is-confirm" : ""}`}
                      title={deleteConfirmId === checkpoint.fileName ? copy.checkpointDeleteConfirm : copy.checkpointDelete}
                      aria-label={copy.checkpointDelete}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (deleteConfirmId !== checkpoint.fileName) {
                          setDeleteConfirmId(checkpoint.fileName);
                          window.setTimeout(() => setDeleteConfirmId((current) => (current === checkpoint.fileName ? null : current)), 3000);
                          return;
                        }
                        setDeleteConfirmId(null);
                        void invokeMutation("delete_database_checkpoint", {
                          connectionId: request.connectionId,
                          fileName: checkpoint.fileName,
                        })
                          .then(() =>
                            setRequest((current) =>
                              current
                                ? {
                                    ...current,
                                    checkpoints: current.checkpoints.filter(
                                      (entry) => entry.fileName !== checkpoint.fileName,
                                    ),
                                  }
                                : current,
                            ),
                          )
                          .catch(() => undefined);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
                  </ul>
                </div>
              </div>
            )
          ) : (
            <>
              <p className="ckpt-dialog__confirm-title">
                <ShieldAlert size={15} />
                {copy.checkpointConfirmTitle}
              </p>
              <div className="ckpt-confirm-card">
                <div className="ckpt-confirm-card__main">
                  <span className="ckpt-confirm-card__label">{confirming.label}</span>
                  <span className="ckpt-confirm-card__meta">{describeCheckpoint(confirming)}</span>
                </div>
              </div>
              {previewLoading ? (
                <p className="ckpt-dialog__loading">
                  <Loader2 size={14} className="animate-spin" />
                  …
                </p>
              ) : previewError ? (
                <div className="ckpt-dialog__error">{previewError}</div>
              ) : preview ? (
                <>
                  <div className="ckpt-stats">
                    <span className="ckpt-stat">
                      <strong>{preview.statementCount}</strong> SQL
                    </span>
                    <span className="ckpt-stat">
                      <strong>{preview.schemaChangeCount}</strong> schema
                    </span>
                    <span className="ckpt-stat">
                      <strong>{preview.dataChangeCount}</strong> data
                    </span>
                    <span
                      className={`ckpt-stat${
                        preview.destructiveStatementCount > 0 ? " ckpt-stat--danger" : ""
                      }`}
                    >
                      <strong>{preview.destructiveStatementCount}</strong> destructive
                    </span>
                  </div>
                  {preview.warning ? (
                    <div className="ckpt-dialog__warning">⚠ {preview.warning}</div>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="ckpt-dialog__footer">
          {confirming ? (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setConfirming(null);
                  setPreview(null);
                }}
              >
                {copy.checkpointBack}
              </button>
              <span className="ckpt-dialog__footer-spacer" />
              <button type="button" className="btn btn-secondary" onClick={close}>
                {copy.checkpointCancel}
              </button>
              <button
                type="button"
                className="btn btn-primary ckpt-btn-danger"
                disabled={previewLoading || !preview || Boolean(previewError)}
                onClick={() => respond(confirming.fileName)}
              >
                {copy.checkpointRestoreAction}
              </button>
            </>
          ) : (
            <>
              <span className="ckpt-dialog__footer-spacer" />
              <button type="button" className="btn btn-secondary" onClick={close} autoFocus>
                {copy.checkpointCancel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
