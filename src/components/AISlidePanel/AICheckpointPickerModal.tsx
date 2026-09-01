import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { History, Loader2, ShieldAlert, ChevronRight, X } from "lucide-react";
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

function formatCheckpointTime(epochMs: number, language: string) {
  try {
    return new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : language, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString();
  }
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

  useEffect(() => {
    setAICheckpointPickerHostMounted(true);
    const handleRequest = (event: Event) => {
      setRequest((event as CustomEvent<AICheckpointPickRequest>).detail);
      setConfirming(null);
      setPreview(null);
      setPreviewError(null);
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
      formatCheckpointTime(checkpoint.createdAt, request.language),
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
              <ul className="ckpt-list">
                {request.checkpoints.map((checkpoint) => (
                  <li key={checkpoint.fileName}>
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
                  </li>
                ))}
              </ul>
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
