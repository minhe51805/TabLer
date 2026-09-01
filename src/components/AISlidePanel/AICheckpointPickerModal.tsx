import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { History, Loader2, ShieldAlert } from "lucide-react";
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
        },
      );
      setPreview(result);
    } catch (errorValue) {
      setPreviewError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setPreviewLoading(false);
    }
  };

  return createPortal(
    <div
      className="ai-workspace-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="ai-workspace-modal ai-checkpoint-modal" role="dialog" aria-modal="true">
        <header className="ai-checkpoint-modal-head">
          <History className="w-4 h-4" />
          <strong>{copy.checkpointTitle}</strong>
        </header>

        {!confirming ? (
          <>
            <p className="ai-checkpoint-modal-hint">{copy.checkpointHint}</p>
            {request.checkpoints.length === 0 ? (
              <p className="ai-checkpoint-modal-empty">{copy.checkpointEmpty}</p>
            ) : (
              <ul className="ai-checkpoint-list">
                {request.checkpoints.map((checkpoint) => (
                  <li key={checkpoint.fileName}>
                    <button
                      type="button"
                      className="ai-checkpoint-item"
                      onClick={() => void startConfirm(checkpoint)}
                    >
                      <span className="ai-checkpoint-item-label">{checkpoint.label}</span>
                      <span className="ai-checkpoint-item-meta">
                        {formatCheckpointTime(checkpoint.createdAt, request.language)}
                        {" · "}
                        {checkpoint.engine}
                        {checkpoint.database ? ` · ${checkpoint.database}` : ""}
                        {" · "}
                        {checkpoint.tableCount}T/{checkpoint.rowCount}R
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <footer className="ai-checkpoint-modal-actions">
              <button type="button" className="ai-workspace-modal-btn" onClick={close} autoFocus>
                {copy.checkpointCancel}
              </button>
            </footer>
          </>
        ) : (
          <>
            <p className="ai-checkpoint-modal-confirm-title">
              <ShieldAlert className="w-4 h-4" />
              {copy.checkpointConfirmTitle}
            </p>
            <div className="ai-checkpoint-confirm-card">
              <strong>{confirming.label}</strong>
              <span>
                {formatCheckpointTime(confirming.createdAt, request.language)}
                {" · "}
                {confirming.tableCount}T/{confirming.rowCount}R
              </span>
            </div>
            {previewLoading ? (
              <p className="ai-checkpoint-modal-loading">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              </p>
            ) : previewError ? (
              <p className="ai-checkpoint-modal-error">{previewError}</p>
            ) : preview ? (
              <>
                <p className="ai-checkpoint-modal-preview">
                  {copy.checkpointPreviewBody
                    .replace("{statements}", String(preview.statementCount))
                    .replace("{schema}", String(preview.schemaChangeCount))
                    .replace("{data}", String(preview.dataChangeCount))
                    .replace("{destructive}", String(preview.destructiveStatementCount))}
                  {!preview.transactional ? " ⚠" : ""}
                </p>
                {preview.warning ? <p className="ai-checkpoint-modal-warning">{preview.warning}</p> : null}
              </>
            ) : null}
            <footer className="ai-checkpoint-modal-actions">
              <button
                type="button"
                className="ai-workspace-modal-btn"
                onClick={() => {
                  setConfirming(null);
                  setPreview(null);
                }}
              >
                {copy.checkpointBack}
              </button>
              <button
                type="button"
                className="ai-workspace-modal-btn danger"
                disabled={previewLoading || !preview || Boolean(previewError)}
                onClick={() => respond(confirming.fileName)}
              >
                {copy.checkpointRestoreAction}
              </button>
              <button type="button" className="ai-workspace-modal-btn" onClick={close} autoFocus>
                {copy.checkpointCancel}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
