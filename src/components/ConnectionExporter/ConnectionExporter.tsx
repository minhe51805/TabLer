import { useState } from "react";
import { Check, CheckCircle2, AlertCircle, Lock, Eye, EyeOff } from "lucide-react";
import type { ConnectionConfig } from "../../types/database";
import { exportConnections } from "../../utils/connection-export";
import "../../styles/lazy-overlays.css";

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
    if (password.length < 10) {
      setError("Password must be at least 10 characters.");
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
    <div className="cex-backdrop">
      <div className="cex-modal">
        {/* Header */}
        <div className="cex-header">
          <div className="cex-header-copy">
            <h2 className="cex-title">Export Connections</h2>
            <p className="cex-subtitle">Save connections as an encrypted, versioned export</p>
          </div>
          <div className="cex-header-actions">
            {result ? (
              <button type="button" onClick={handleClose} className="cex-btn-primary">
                <Check className="w-4 h-4" />
                Done
              </button>
            ) : (
              <>
                <button type="button" onClick={onClose} className="cex-btn-cancel" disabled={isExporting}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleExport}
                  disabled={isExporting || selected.size === 0 || !password}
                  className="cex-btn-primary"
                >
                  {isExporting ? (
                    "Exporting..."
                  ) : (
                    <>
                      <Check className="w-4 h-4" />
                      Export {selected.size} Connection{selected.size !== 1 ? "s" : ""}
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Body */}
        {result ? (
          <div className="cex-body cex-body-centered">
            <div className="cex-success">
              <CheckCircle2 />
              <p>{result.message}</p>
              <button onClick={handleClose} className="btn btn-primary">Done</button>
            </div>
          </div>
        ) : (
          <div className="cex-body">
            {/* Left rail: connection selection */}
            <aside className="cex-rail">
              <div className="cex-rail-head">
                <label className="cex-section-label">
                  Select ({selected.size}/{connections.length})
                </label>
                <button onClick={toggleAll} className="cex-toggle-all">
                  {selected.size === connections.length ? "Deselect All" : "Select All"}
                </button>
              </div>
              <div className="cex-rail-list">
                {connections.length === 0 ? (
                  <p className="cex-rail-empty">No saved connections to export.</p>
                ) : (
                  connections.map((conn) => (
                    <label
                      key={conn.id}
                      className={`cex-rail-item ${selected.has(conn.id) ? "is-selected" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(conn.id)}
                        onChange={() => toggleSelect(conn.id)}
                      />
                      <span className="cex-rail-item-name">{conn.name || conn.host || conn.db_type}</span>
                      <span className="cex-rail-item-meta">{conn.db_type}</span>
                    </label>
                  ))
                )}
              </div>
            </aside>

            {/* Right detail: encryption */}
            <div className="cex-detail">

              {/* Encryption password */}
              <div className="cex-warning">
                <Lock className="w-4 h-4" />
                <p>
                  Connections will be encrypted with AES-256-GCM. Passwords are not exported — you will need to re-enter them when importing.
                </p>
              </div>

              <div className="cex-fieldset">
                <div className="connection-form-field">
                  <label className="form-label uppercase tracking-wide">
                    Encryption Password <span className="text-red-400">*</span>
                  </label>
                  <div className="connection-form-password">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Min. 10 characters"
                      className="input h-11 pr-11"
                      minLength={10}
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
                    minLength={10}
                  />
                </div>
              </div>

              {error && (
                <div className="cex-error">
                  <AlertCircle className="w-4 h-4" />
                  <p>{error}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
