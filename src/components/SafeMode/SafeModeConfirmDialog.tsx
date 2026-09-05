import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ShieldAlert, X, Info, Copy, Check } from "lucide-react";
import { useSafeModeStore } from "../../stores/safeModeStore";
import { SAFE_MODE_LABELS } from "../../types/safe-mode";

interface ConfirmRequest {
  id?: number;
  sql: string;
  connectionId?: string;
  level: number;
}

interface ConfirmResponse {
  id?: number;
  sql: string;
  approved: boolean;
}

const MAX_PREVIEW_CHARS = 800;

/**
 * Host for Safe Mode run approvals. Listens for confirm requests dispatched
 * by `safe-mode-query-guard` and renders a themed modal with the full SQL
 * preview. Rendered through a portal so the overlay always covers the app
 * regardless of stacking contexts.
 */
export function SafeModeConfirmDialog() {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [copied, setCopied] = useState(false);
  const { hasAdminPassword, verifyAdminPassword } = useSafeModeStore();

  useEffect(() => {
    const handleRequest = (e: Event) => {
      const detail = (e as CustomEvent<ConfirmRequest>).detail;
      setRequest(detail);
      setPassword("");
      setPasswordError("");
      setOpen(true);
    };

    window.addEventListener("safe-mode-confirm-request", handleRequest as EventListener);
    return () => {
      window.removeEventListener("safe-mode-confirm-request", handleRequest as EventListener);
    };
  }, []);

  const respond = (approved: boolean) => {
    if (!request) return;
    window.dispatchEvent(
      new CustomEvent<ConfirmResponse>("safe-mode-confirm-response", {
        detail: { id: request.id, sql: request.sql, approved },
      }),
    );
    setOpen(false);
    setRequest(null);
    setPassword("");
    setPasswordError("");
  };

  const handleApprove = () => {
    if (!request) return;

    // Level 4-5 need admin password
    if (request.level >= 4) {
      if (!hasAdminPassword()) {
        setPasswordError("No admin password set. Please set one in Safe Mode settings first.");
        return;
      }
      if (!verifyAdminPassword(password)) {
        setPasswordError("Incorrect admin password.");
        return;
      }
    }

    respond(true);
  };

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") respond(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, request]);

  if (!open || !request) return null;

  const level = request.level as 0 | 1 | 2 | 3 | 4 | 5;
  const levelInfo = SAFE_MODE_LABELS[level];
  const needsPassword = level >= 4;
  const isStrict = level >= 4;

  const previewSql = request.sql.length > MAX_PREVIEW_CHARS
    ? `${request.sql.slice(0, MAX_PREVIEW_CHARS)}…`
    : request.sql;

  const handleCopySql = async () => {
    try {
      await navigator.clipboard.writeText(request.sql);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  const dialog = (
    <div className="safe-mode-overlay" onClick={() => respond(false)}>
      <div
        className={`safe-mode-dialog${isStrict ? " safe-mode-dialog--strict" : ""}`}
        onClick={(event) => event.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="safe-mode-dialog-title"
      >
        {/* Header */}
        <div className="safe-mode-dialog__header">
          <div className="safe-mode-dialog__icon">
            <ShieldAlert size={21} strokeWidth={2} />
          </div>
          <div className="safe-mode-dialog__heading">
            <h2 id="safe-mode-dialog-title" className="safe-mode-dialog__title">
              Safe Mode: Confirmation Required
            </h2>
            <span className="safe-mode-dialog__level-chip">
              LEVEL {level} · {levelInfo.label.toUpperCase()}
            </span>
          </div>
          <button
            type="button"
            onClick={() => respond(false)}
            className="safe-mode-dialog__close"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="safe-mode-dialog__body">
          <p className="safe-mode-dialog__description">{levelInfo.description}</p>

          {/* SQL Preview */}
          <div>
            <div className="safe-mode-dialog__sql-label">
              <span>SQL Statement</span>
              <button type="button" onClick={handleCopySql} className="safe-mode-dialog__copy">
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="safe-mode-dialog__sql">{previewSql}</pre>
            {request.sql.length > MAX_PREVIEW_CHARS && (
              <p className="safe-mode-dialog__sql-length">
                Showing first {MAX_PREVIEW_CHARS} of {request.sql.length} chars
              </p>
            )}
          </div>

          {/* Level 5: estimated row count info */}
          {level === 5 && (
            <div className="safe-mode-dialog__hint">
              <Info size={14} />
              <span>
                At Paranoid level, preview affected rows with a{" "}
                <code>SELECT COUNT(*) …</code> query before executing.
              </span>
            </div>
          )}

          {/* Admin password for level 4-5 */}
          {needsPassword && (
            <div>
              <label className="safe-mode-dialog__field-label" htmlFor="safe-mode-admin-password">
                Admin Password (required for level {level})
              </label>
              <input
                id="safe-mode-admin-password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPasswordError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleApprove();
                }}
                placeholder="Enter admin password"
                className="safe-mode-dialog__password"
                autoFocus
              />
              {passwordError && (
                <p className="safe-mode-dialog__field-error">{passwordError}</p>
              )}
              {!hasAdminPassword() && (
                <p className="safe-mode-dialog__field-note">
                  No admin password is set. Configure one in Settings &gt; Safe Mode first.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="safe-mode-dialog__footer">
          <button type="button" onClick={() => respond(false)} className="btn btn-secondary" autoFocus>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApprove}
            disabled={needsPassword && !password}
            className="btn btn-primary"
          >
            Execute
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
