import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { History, RotateCcw, Trash2, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { emitAppToast } from "../../utils/app-toast";
import { useQueryStore } from "../../stores/queryStore";
import type { RefusalCode, RewindCheckpointInfo } from "../../types";
import { getRewindCopy, type RewindCopy } from "./rewind-copy";
import "./datagrid-rewind.css";

interface DataGridRewindModalProps {
  /** Connection whose checkpoints are listed; rewind capture is scoped per connection. */
  connectionId: string;
  onClose: () => void;
  /** Called after a successful restore so the parent can reload the grid. */
  onRestored?: () => void | Promise<void>;
}

/** Backend retention window: checkpoints older than this are shown with an
 *  "expired" badge; the backend still decides whether restore is refused. */
const REWIND_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function relativeTime(createdAtMs: number, copy: RewindCopy): string {
  const deltaSeconds = Math.max(0, Math.round((Date.now() - createdAtMs) / 1000));
  if (deltaSeconds < 60) return copy.ago.seconds(deltaSeconds);
  if (deltaSeconds < 3600) return copy.ago.minutes(Math.round(deltaSeconds / 60));
  if (deltaSeconds < 86_400) return copy.ago.hours(Math.round(deltaSeconds / 3600));
  return copy.ago.days(Math.round(deltaSeconds / 86_400));
}

/**
 * List the encrypted pre-write checkpoints captured for a connection and run
 * restore/delete against them. Engines without rewind capture simply return an
 * empty list — the modal shows the empty state rather than failing.
 */
export function DataGridRewindModal({
  connectionId,
  onClose,
  onRestored,
}: DataGridRewindModalProps) {
  const { language } = useI18n();
  const copy = getRewindCopy(language);
  const [checkpoints, setCheckpoints] = useState<RewindCheckpointInfo[] | null>(null);
  /** Checkpoint id currently being restored or deleted; disables its buttons. */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Refusal codes from the last restore attempt, per checkpoint id —
   *  rendered inline under the row; the checkpoint stays listed. */
  const [refusalsById, setRefusalsById] = useState<Record<string, RefusalCode[]>>({});

  const reload = useCallback(async () => {
    try {
      setCheckpoints(await useQueryStore.getState().listRewindCheckpoints(connectionId));
    } catch (error) {
      setCheckpoints([]);
      emitAppToast({
        title: copy.loadFailed,
        description: String(error),
        tone: "error",
      });
    }
  }, [connectionId, copy]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleRestore = async (checkpoint: RewindCheckpointInfo) => {
    const confirmed = window.confirm(
      copy.confirmRestore(checkpoint.tableName, copy.kinds[checkpoint.kind], checkpoint.rowCount),
    );
    if (!confirmed) return;
    setBusyId(checkpoint.id);
    try {
      const outcome = await useQueryStore
        .getState()
        .restoreRewindCheckpoint(connectionId, checkpoint.id);
      if (outcome.refusals.length > 0) {
        // Refusal, not a transport error: explain inline and keep the row —
        // the backend kept the checkpoint too.
        setRefusalsById((current) => ({ ...current, [checkpoint.id]: outcome.refusals }));
        return;
      }
      setRefusalsById((current) => {
        const next = { ...current };
        delete next[checkpoint.id];
        return next;
      });
      emitAppToast({
        title: copy.restoredToast(outcome.restored ?? checkpoint.rowCount, checkpoint.tableName),
        tone: "success",
      });
      await reload();
      await onRestored?.();
    } catch (error) {
      emitAppToast({
        title: copy.actionFailed,
        description: String(error),
        tone: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (checkpoint: RewindCheckpointInfo) => {
    setBusyId(checkpoint.id);
    try {
      await useQueryStore.getState().deleteRewindCheckpoint(connectionId, checkpoint.id);
      await reload();
    } catch (error) {
      emitAppToast({
        title: copy.actionFailed,
        description: String(error),
        tone: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  return createPortal(
    <div className="qs-overlay" role="presentation" onClick={onClose}>
      <div
        className="qs-panel data-import-panel"
        role="dialog"
        aria-label={copy.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="qs-input-row">
          <strong>
            <History size={14} className="inline-block mr-1" />
            {copy.title}
          </strong>
          <button type="button" className="qs-clear-btn" aria-label={copy.close} onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="datagrid-rewind-hint">{copy.unsupportedHint}</div>

        {checkpoints === null ? (
          <div className="qs-empty">…</div>
        ) : checkpoints.length === 0 ? (
          <div className="qs-empty">{copy.empty}</div>
        ) : (
          <div className="qs-list schema-diff-results">
            {checkpoints.map((checkpoint) => {
              const refusals = refusalsById[checkpoint.id];
              const isExpired = Date.now() - checkpoint.createdAtMs > REWIND_EXPIRY_MS;
              return (
                <div key={checkpoint.id} className="qs-item static datagrid-rewind-row">
                  <div className="datagrid-rewind-item">
                    <span className={`datagrid-rewind-kind ${checkpoint.kind}`}>
                      {copy.kinds[checkpoint.kind]}
                    </span>
                    <span className="datagrid-rewind-name" title={checkpoint.tableName}>
                      {checkpoint.tableName}
                    </span>
                    {checkpoint.database && (
                      <span className="datagrid-rewind-db">{checkpoint.database}</span>
                    )}
                    {isExpired && (
                      <span className="datagrid-rewind-expired">{copy.expiredBadge}</span>
                    )}
                    <span className="datagrid-rewind-meta">
                      {copy.rowsCount(checkpoint.rowCount)} ·{" "}
                      {relativeTime(checkpoint.createdAtMs, copy)}
                    </span>
                    <span className="datagrid-rewind-actions">
                      <button
                        type="button"
                        className="datagrid-rewind-action"
                        disabled={busyId !== null}
                        aria-label={`${copy.restore} ${checkpoint.tableName}`}
                        onClick={() => void handleRestore(checkpoint)}
                      >
                        <RotateCcw size={12} /> {copy.restore}
                      </button>
                      <button
                        type="button"
                        className="datagrid-rewind-action danger"
                        disabled={busyId !== null}
                        aria-label={`${copy.delete} ${checkpoint.tableName}`}
                        onClick={() => void handleDelete(checkpoint)}
                      >
                        <Trash2 size={12} /> {copy.delete}
                      </button>
                    </span>
                  </div>
                  {refusals && refusals.length > 0 && (
                    <div className="datagrid-rewind-refusal" role="status">
                      {refusals.map((code) => copy.refusals[code]).join(" · ")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
