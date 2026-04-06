import { useState, useEffect } from "react";
import { ShieldAlert, X, AlertTriangle } from "lucide-react";
import { useSafeModeStore } from "../../stores/safeModeStore";
import { SAFE_MODE_LABELS } from "../../types/safe-mode";

interface ConfirmRequest {
  sql: string;
  connectionId?: string;
  level: number;
}

interface ConfirmResponse {
  sql: string;
  approved: boolean;
}

export function SafeModeConfirmDialog() {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
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

  const handleApprove = () => {
    if (!request) return;
    const { level } = request;

    // Level 4-5 need admin password
    if (level >= 4) {
      if (!hasAdminPassword()) {
        setPasswordError("No admin password set. Please set one in Safe Mode settings first.");
        return;
      }
      if (!verifyAdminPassword(password)) {
        setPasswordError("Incorrect admin password.");
        return;
      }
    }

    const response: ConfirmResponse = { sql: request.sql, approved: true };
    window.dispatchEvent(new CustomEvent("safe-mode-confirm-response", { detail: response }));
    setOpen(false);
    setRequest(null);
    setPassword("");
    setPasswordError("");
  };

  const handleCancel = () => {
    if (!request) return;
    const response: ConfirmResponse = { sql: request.sql, approved: false };
    window.dispatchEvent(new CustomEvent("safe-mode-confirm-response", { detail: response }));
    setOpen(false);
    setRequest(null);
    setPassword("");
    setPasswordError("");
  };

  if (!open || !request) return null;

  const level = request.level as 0 | 1 | 2 | 3 | 4 | 5;
  const levelInfo = SAFE_MODE_LABELS[level];
  const needsPassword = level >= 4;

  // Estimate rows for level 5 preview (we show a rough note)
  const sqlSnippet = request.sql.length > 500 ? request.sql.slice(0, 500) + "..." : request.sql;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-center w-10 h-10 rounded-full bg-amber-500/10 text-amber-500">
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              Safe Mode: Confirmation Required
            </h2>
            <p className="text-xs text-[var(--text-muted)]">
              Level {level} — {levelInfo.label}
            </p>
          </div>
          <button
            onClick={handleCancel}
            className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/20">
            <p className="text-sm text-[var(--text-secondary)]">
              {levelInfo.description}
            </p>
          </div>

          {/* SQL Preview */}
          <div>
            <p className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">
              SQL Statement
            </p>
            <div className="bg-[var(--bg-primary)] rounded-lg p-3 border border-[var(--border)] overflow-x-auto">
              <pre className="text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-all">
                {sqlSnippet}
              </pre>
            </div>
            {request.sql.length > 500 && (
              <p className="text-xs text-[var(--text-muted)] mt-1">
                Statement truncated for display (full length: {request.sql.length} chars)
              </p>
            )}
          </div>

          {/* Level 5: estimated row count info */}
          {level === 5 && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-500/5 border border-blue-500/20">
              <AlertTriangle className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
              <p className="text-xs text-[var(--text-secondary)]">
                At Paranoid level, you may want to preview affected rows with a COUNT query
                before executing. Consider running <code className="font-mono text-[var(--text-primary)]">SELECT COUNT(*) ...</code> first.
              </p>
            </div>
          )}

          {/* Admin password for level 4-5 */}
          {needsPassword && (
            <div>
              <label className="text-xs uppercase tracking-wide text-[var(--text-muted)] block mb-2">
                Admin Password (required for level {level})
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPasswordError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleApprove();
                  if (e.key === "Escape") handleCancel();
                }}
                placeholder="Enter admin password"
                className="input h-11 w-full"
                autoFocus
              />
              {passwordError && (
                <p className="text-xs text-red-400 mt-1.5">{passwordError}</p>
              )}
              {!hasAdminPassword() && (
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  No admin password is set. Configure one in Settings &gt; Safe Mode first.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--border)]">
          <button onClick={handleCancel} className="btn btn-secondary">
            Cancel
          </button>
          <button
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
}
