import { useCallback, useEffect, useState } from "react";
import { Brain, Eye, EyeOff, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import { invokeMutation } from "../../utils/tauri-utils";
import { ConfirmDialog } from "../ConfirmDialog";
import { formatMemoryCopy, getAIMemoryCopy } from "./ai-memory-copy";
import { invalidateAgentMemoryIndex, type AgentMemoryIndexEntry } from "./hooks/use-agent-memory";
import "./ai-memory-manager.css";

interface AIMemoryManagerModalProps {
  open: boolean;
  language: string;
  /** Scope the memories live under — same (connection, database) pair the
   *  agent tools write to. */
  connectionId: string | null;
  database: string | null;
  onClose: () => void;
}

/**
 * User-facing view over the agent memory store: the agent's save_memory /
 * native memory tool writes are otherwise invisible — this lists every entry
 * in the current scope, shows bodies on demand, and deletes with the same
 * explicit confirm the tools require.
 */

/** ISO timestamps like "2026-09-23T15:47:09.299144+00:00" render as a short
 *  local date+time; unparseable values pass through trimmed. */
function formatMemoryTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.split(".")[0] ?? iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function AIMemoryManagerModal({
  open,
  language,
  connectionId,
  database,
  onClose,
}: AIMemoryManagerModalProps) {
  const copy = getAIMemoryCopy(language);
  const [entries, setEntries] = useState<AgentMemoryIndexEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Name → body for entries the user opened. */
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [clearAllPending, setClearAllPending] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await invokeMutation<AgentMemoryIndexEntry[]>("list_agent_memory", {
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
      setBodies({});
      void refresh();
    }
  }, [open, refresh]);

  const viewBody = useCallback(
    async (name: string) => {
      if (bodies[name] !== undefined) {
        setBodies((current) => {
          const next = { ...current };
          delete next[name];
          return next;
        });
        return;
      }
      try {
        const content = await invokeMutation<{ name: string; body: string }>("read_agent_memory", {
          name,
          connectionId,
          database,
        });
        setBodies((current) => ({ ...current, [name]: content.body }));
      } catch (err) {
        setError(String(err));
      }
    },
    [bodies, connectionId, database],
  );

  const deleteMemory = useCallback(
    async (name: string) => {
      setBusy(true);
      try {
        await invokeMutation("delete_agent_memory", { name, connectionId, database });
        invalidateAgentMemoryIndex(connectionId ?? undefined);
        setEntries((current) => current.filter((entry) => entry.name !== name));
        setBodies((current) => {
          const next = { ...current };
          delete next[name];
          return next;
        });
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
        setDeleteTarget(null);
      }
    },
    [connectionId, database],
  );

  const clearAll = useCallback(async () => {
    setBusy(true);
    try {
      for (const entry of entries) {
        await invokeMutation("delete_agent_memory", {
          name: entry.name,
          connectionId,
          database,
        });
      }
      invalidateAgentMemoryIndex(connectionId ?? undefined);
      setEntries([]);
      setBodies({});
    } catch (err) {
      setError(String(err));
      void refresh();
    } finally {
      setBusy(false);
      setClearAllPending(false);
    }
  }, [entries, connectionId, database, refresh]);

  if (!open) return null;

  return (
    <div className="ai-workspace-modal-layer">
      <div
        className="ai-workspace-modal ai-skills-manager-modal"
        role="dialog"
        aria-modal="true"
        aria-label={copy.title}
      >
        <div className="ai-workspace-modal-header">
          <div className="ai-workspace-modal-copy">
            <span className="ai-workspace-modal-kicker">
              <Brain className="w-3.5 h-3.5" aria-hidden="true" /> {copy.scopeLabel}:{" "}
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
            <ul className="ai-memory-manager-list">
              {entries.map((entry) => (
                <li key={entry.name} className="ai-memory-manager-row">
                  <div className="ai-memory-manager-row-main">
                    <span className="ai-memory-manager-row-name">{entry.name}</span>
                    {entry.description ? (
                      <span className="ai-memory-manager-row-desc">{entry.description}</span>
                    ) : null}
                    <span className="ai-memory-manager-row-meta">
                      {formatMemoryTimestamp(entry.updatedAt)}
                    </span>
                    {bodies[entry.name] !== undefined ? (
                      <pre className="ai-memory-manager-body-text">{bodies[entry.name]}</pre>
                    ) : null}
                  </div>
                  <div className="ai-memory-manager-row-actions">
                    <button
                      type="button"
                      className="ai-skills-manager-btn is-icon"
                      onClick={() => void viewBody(entry.name)}
                      title={bodies[entry.name] !== undefined ? copy.hideAction : copy.viewAction}
                      aria-label={
                        bodies[entry.name] !== undefined ? copy.hideAction : copy.viewAction
                      }
                    >
                      {bodies[entry.name] !== undefined ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="ai-skills-manager-btn is-icon is-danger"
                      onClick={() => setDeleteTarget(entry.name)}
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
          message={formatMemoryCopy(copy.deleteBody, { name: deleteTarget ?? "" })}
          confirmText={copy.deleteConfirm}
          cancelText={copy.cancelLabel}
          onConfirm={() => {
            if (deleteTarget) void deleteMemory(deleteTarget);
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
