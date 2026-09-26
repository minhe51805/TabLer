import { useCallback, useEffect, useState } from "react";
import { BookMarked, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import { invokeMutation } from "../../utils/tauri-utils";
import { ConfirmDialog } from "../ConfirmDialog";
import {
  deleteSemanticGlossaryEntry,
  invalidateSemanticGlossary,
  type SemanticGlossaryEntry,
} from "../../utils/semantic-glossary";
import { getAISemanticCopy } from "./ai-semantic-copy";
import "./ai-semantic-glossary.css";

interface AISemanticGlossaryModalProps {
  open: boolean;
  language: string;
  /** Scope the entries live under — same (connection, database) pair the
   *  remember_term tool writes to. */
  connectionId: string | null;
  database: string | null;
  onClose: () => void;
}

/**
 * User-facing audit view over the semantic glossary: remember_term writes
 * are otherwise invisible (no UI surface existed before this modal), so a
 * wrong agent-learned meaning would silently steer every future run. This
 * lists every entry in the scope and deletes with an explicit confirm.
 */

/** ISO timestamps render as a short local date+time; unparseable values
 *  pass through trimmed. */
function formatEntryTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.split(".")[0] ?? iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AISemanticGlossaryModal({
  open,
  language,
  connectionId,
  database,
  onClose,
}: AISemanticGlossaryModalProps) {
  const copy = getAISemanticCopy(language);
  const [entries, setEntries] = useState<SemanticGlossaryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SemanticGlossaryEntry | null>(null);
  const [clearAllPending, setClearAllPending] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!connectionId) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await invokeMutation<SemanticGlossaryEntry[]>("get_semantic_entries", {
        connectionId,
        database,
      });
      setEntries(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId, database]);

  useEffect(() => {
    if (open) {
      void refresh();
    }
  }, [open, refresh]);

  const deleteEntry = useCallback(
    async (entry: SemanticGlossaryEntry) => {
      setBusy(true);
      try {
        await deleteSemanticGlossaryEntry(entry.id);
        invalidateSemanticGlossary(connectionId ?? undefined);
        setEntries((current) => current.filter((item) => item.id !== entry.id));
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
        setDeleteTarget(null);
      }
    },
    [connectionId],
  );

  const clearAll = useCallback(async () => {
    setBusy(true);
    try {
      for (const entry of entries) {
        await deleteSemanticGlossaryEntry(entry.id);
      }
      invalidateSemanticGlossary(connectionId ?? undefined);
      setEntries([]);
    } catch (err) {
      setError(String(err));
      void refresh();
    } finally {
      setBusy(false);
      setClearAllPending(false);
    }
  }, [entries, connectionId, refresh]);

  if (!open) return null;

  return (
    <div className="ai-workspace-modal-layer">
      <div
        className="ai-workspace-modal ai-memory-manager-modal ai-semantic-glossary-modal"
        role="dialog"
        aria-modal="true"
        aria-label={copy.title}
      >
        <div className="ai-workspace-modal-header">
          <div className="ai-workspace-modal-copy">
            <span className="ai-workspace-modal-kicker">
              <BookMarked className="w-3.5 h-3.5" aria-hidden="true" /> {copy.scopeLabel}:{" "}
              {database || "—"}
            </span>
            <h3 className="ai-workspace-modal-title">{copy.title}</h3>
          </div>
          <div className="ai-skills-manager-actions">
            <button
              type="button"
              className="ai-skills-manager-btn is-icon"
              onClick={() => void refresh()}
              disabled={loading}
              title={copy.refresh}
              aria-label={copy.refresh}
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
            </button>
            <button
              type="button"
              className="ai-workspace-modal-close"
              onClick={onClose}
              title={copy.closeAction}
              aria-label={copy.closeAction}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="ai-skills-manager-body">
          <p className="ai-skills-manager-field-hint">{copy.subtitle}</p>
          {error ? (
            <div className="ai-skills-manager-error" role="alert">
              <span>
                {copy.loadFailed} {error}
              </span>
            </div>
          ) : null}

          {entries.length === 0 ? (
            <div className="ai-skills-manager-empty">
              {loading ? copy.loading : `${copy.empty} ${copy.emptyHint}`}
            </div>
          ) : (
            <ul className="ai-memory-manager-list ai-semantic-glossary-list">
              {entries.map((entry) => (
                <li key={entry.id} className="ai-memory-manager-row">
                  <div className="ai-memory-manager-row-main">
                    <span className="ai-memory-manager-row-name">
                      {entry.term}
                      <span className="ai-semantic-glossary-badges">
                        <span className="ai-semantic-glossary-badge is-kind">
                          {copy.kindLabel}: {entry.kind}
                        </span>
                        <span
                          className={`ai-semantic-glossary-badge is-source-${
                            entry.source === "agent" ? "agent" : "user"
                          }`}
                        >
                          {entry.source === "agent" ? copy.sourceAgent : copy.sourceUser}
                        </span>
                      </span>
                    </span>
                    <span className="ai-memory-manager-row-desc">{entry.definition}</span>
                    <span className="ai-memory-manager-row-meta">
                      {formatEntryTimestamp(entry.updatedAt)}
                    </span>
                  </div>
                  <div className="ai-memory-manager-row-actions">
                    <button
                      type="button"
                      className="ai-skills-manager-btn is-icon is-danger"
                      onClick={() => setDeleteTarget(entry)}
                      disabled={busy}
                      title={copy.deleteAction}
                      aria-label={copy.deleteAction}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {entries.length > 0 ? (
            <div className="ai-memory-manager-footer">
              <button
                type="button"
                className="ai-skills-manager-btn is-ghost"
                onClick={() => setClearAllPending(true)}
                disabled={busy}
              >
                {copy.clearAllAction}
              </button>
            </div>
          ) : null}
        </div>

        <ConfirmDialog
          isOpen={deleteTarget !== null}
          title={copy.deleteTitle}
          message={copy.deleteBody.replace("{term}", deleteTarget?.term ?? "")}
          confirmText={copy.deleteConfirm}
          cancelText={copy.cancelLabel}
          onConfirm={() => {
            if (deleteTarget) void deleteEntry(deleteTarget);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
        <ConfirmDialog
          isOpen={clearAllPending}
          title={copy.clearAllTitle}
          message={copy.clearAllBody}
          confirmText={copy.clearAllConfirm}
          cancelText={copy.cancelLabel}
          onConfirm={() => void clearAll()}
          onCancel={() => setClearAllPending(false)}
        />
      </div>
    </div>
  );
}
