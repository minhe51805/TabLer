import { useState } from "react";
import { X, Download, CheckCircle2, AlertCircle, Lock, Eye, EyeOff } from "lucide-react";
import type { ConnectionConfig } from "../../types/database";
import { exportConnections } from "../../utils/connection-export";

interface ConnectionExporterProps {
  connections: ConnectionConfig[];
  onClose: () => void;
}

export function ConnectionExporter({ connections, onClose }: ConnectionExporterProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set(connections.map((c) => c.id)));
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleAll = () => {
    if (selected.size === connections.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(connections.map((c) => c.id)));
    }
  };

  const handleExport = async () => {
    setError(null);
    if (password.length < 4) {
      setError("Password must be at least 4 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (selected.size === 0) {
      setError("Please select at least one connection.");
      return;
    }

    setIsExporting(true);
    const toExport = connections.filter((c) => selected.has(c.id));
    const res = await exportConnections(toExport, password);
    setIsExporting(false);

    if (res.success) {
      setResult({ success: true, message: `Exported ${selected.size} connection(s) to ${res.filePath}` });
    } else if (res.error) {
      setError(res.error);
    }
  };

  const handleClose = () => {
    if (result?.success) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
            <Download className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Export Connections</h2>
            <p className="text-xs text-[var(--text-muted)]">Save connections as an encrypted .tablepro file</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {result ? (
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 className="w-12 h-12 text-green-500" />
              <p className="text-sm font-medium text-[var(--text-primary)]">{result.message}</p>
              <button onClick={handleClose} className="btn btn-primary">Done</button>
            </div>
          ) : (
            <>
              {/* Connection selection */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                    Select Connections ({selected.size}/{connections.length})
                  </label>
                  <button
                    onClick={toggleAll}
                    className="text-xs text-[var(--accent)] hover:underline"
                  >
                    {selected.size === connections.length ? "Deselect All" : "Select All"}
                  </button>
                </div>
                <div className="space-y-1 max-h-48 overflow-y-auto border border-[var(--border)] rounded-lg p-2">
                  {connections.map((conn) => (
                    <label
                      key={conn.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--bg-tertiary)] cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(conn.id)}
                        onChange={() => toggleSelect(conn.id)}
                        className="rounded"
                      />
                      <span className="text-sm text-[var(--text-primary)]">{conn.name || conn.host || conn.db_type}</span>
                      <span className="text-xs text-[var(--text-muted)]">{conn.db_type}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Encryption password */}
              <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/20 flex items-start gap-2">
                <Lock className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                <p className="text-xs text-[var(--text-secondary)]">
                  Connections will be encrypted with AES-256-GCM. Passwords are not exported — you will need to re-enter them when importing.
                </p>
              </div>

              <div className="space-y-3">
                <div className="connection-form-field">
                  <label className="form-label uppercase tracking-wide">
                    Encryption Password <span className="text-red-400">*</span>
                  </label>
                  <div className="connection-form-password">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Min. 4 characters"
                      className="input h-11 pr-11"
                      minLength={4}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="connection-form-password-toggle"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div className="connection-form-field">
                  <label className="form-label uppercase tracking-wide">
                    Confirm Password <span className="text-red-400">*</span>
                  </label>
                  <input
                    type={showPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repeat password"
                    className="input h-11"
                    minLength={4}
                  />
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  <p className="text-sm text-red-400">{error}</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!result && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--border)]">
            <button onClick={onClose} className="btn btn-secondary">Cancel</button>
            <button
              onClick={handleExport}
              disabled={isExporting || selected.size === 0 || !password}
              className="btn btn-primary"
            >
              {isExporting ? "Exporting..." : `Export ${selected.size} Connection${selected.size !== 1 ? "s" : ""}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
