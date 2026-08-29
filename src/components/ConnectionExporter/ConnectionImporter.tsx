import { useState } from "react";
import { Check, CheckCircle2, AlertCircle, Lock, Eye, EyeOff, FileUp } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ConnectionConfig } from "../../types/database";
import { exportableToConnectionConfig, type ExportableConnection } from "../../utils/connection-export";
import "../../styles/lazy-overlays.css";

interface ConnectionImporterProps {
  onImport: (connections: ConnectionConfig[]) => void;
  onClose: () => void;
}

export function ConnectionImporter({ onImport, onClose }: ConnectionImporterProps) {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [previewConnections, setPreviewConnections] = useState<ExportableConnection[] | null>(null);
  const [selectedForImport, setSelectedForImport] = useState<Set<number>>(new Set());
  const [passwords, setPasswords] = useState<Record<number, string>>({});
  const [result, setResult] = useState<{ success: boolean; count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePickFile = async () => {
    setError(null);
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "TableR Connection Export", extensions: ["tabler-connections"] }],
      });
      if (picked && typeof picked === "string") {
        setFilePath(picked);
        setPreviewConnections(null);
        setSelectedForImport(new Set());
        setResult(null);
      }
    } catch (e) {
      setError(`Failed to open file dialog: ${e}`);
    }
  };

  const handleDecrypt = async () => {
    if (!filePath || !password) return;
    setIsDecrypting(true);
    setError(null);
    try {
      const connections = await invoke<ExportableConnection[]>("import_connections_from_file", {
        filePath,
        password,
      });
      setPreviewConnections(connections);
      setSelectedForImport(new Set(connections.map((_, i) => i)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Decryption failed") || msg.includes("Incorrect password")) {
        setError("Incorrect password. Please try again.");
      } else {
        setError(msg);
      }
    } finally {
      setIsDecrypting(false);
    }
  };

  const handleImport = async () => {
    if (!previewConnections) return;
    setIsLoading(true);
    setError(null);
    try {
      const toImport = previewConnections
        .filter((_, i) => selectedForImport.has(i))
        .map((ec, i) => {
          const config = exportableToConnectionConfig(ec, passwords[i] || "");
          return {
            ...config,
            id: crypto.randomUUID(),
          } as ConnectionConfig;
        });

      onImport(toImport);
      setResult({ success: true, count: toImport.length });
    } catch (e) {
      setError(`Import failed: ${e}`);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleSelect = (i: number) => {
    const next = new Set(selectedForImport);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setSelectedForImport(next);
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
            <h2 className="cex-title">Import Connections</h2>
            <p className="cex-subtitle">Load connections from an encrypted TableR file</p>
          </div>
          <div className="cex-header-actions">
            {result ? (
              <button type="button" onClick={handleClose} className="cex-btn-primary">
                <Check className="w-4 h-4" />
                Done
              </button>
            ) : (
              <>
                <button type="button" onClick={onClose} className="cex-btn-cancel" disabled={isLoading || isDecrypting}>
                  Cancel
                </button>
                {previewConnections ? (
                  <button
                    type="button"
                    onClick={handleImport}
                    disabled={isLoading || selectedForImport.size === 0}
                    className="cex-btn-primary"
                  >
                    {isLoading ? (
                      "Importing..."
                    ) : (
                      <>
                        <Check className="w-4 h-4" />
                        Import {selectedForImport.size} Connection{selectedForImport.size !== 1 ? "s" : ""}
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleDecrypt()}
                    disabled={!filePath || !password || isDecrypting}
                    className="cex-btn-primary"
                  >
                    {isDecrypting ? "Decrypting..." : "Open File"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Body */}
        {result ? (
          <div className="cex-body cex-body-centered">
            <div className="cex-success">
              <CheckCircle2 />
              <p>
                Successfully imported {result.count} connection{result.count !== 1 ? "s" : ""}
              </p>
              <button onClick={handleClose} className="btn btn-primary">Done</button>
            </div>
          </div>
        ) : (
          <div className="cex-body">
            {/* Left rail: preview selection */}
            <aside className="cex-rail">
              <div className="cex-rail-head">
                <label className="cex-section-label">
                  {previewConnections
                    ? `Select (${selectedForImport.size}/${previewConnections.length})`
                    : "Preview"}
                </label>
                {previewConnections && (
                  <button
                    onClick={() => setSelectedForImport(
                      selectedForImport.size === previewConnections.length
                        ? new Set()
                        : new Set(previewConnections.map((_, i) => i))
                    )}
                    className="cex-toggle-all"
                  >
                    {selectedForImport.size === previewConnections.length ? "Deselect All" : "Select All"}
                  </button>
                )}
              </div>
              <div className="cex-rail-list">
                {!previewConnections ? (
                  <p className="cex-rail-empty">
                    Pick a .tabler-connections file to preview the connections stored inside it.
                  </p>
                ) : (
                  previewConnections.map((conn, i) => (
                    <label
                      key={i}
                      className={`cex-rail-item ${selectedForImport.has(i) ? "is-selected" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedForImport.has(i)}
                        onChange={() => toggleSelect(i)}
                      />
                      <span className="cex-rail-item-name">{conn.name || conn.host || conn.dbType}</span>
                      <span className="cex-rail-item-meta">{conn.dbType}</span>
                    </label>
                  ))
                )}
              </div>
            </aside>

            {/* Right detail */}
            <div className="cex-detail">
              {previewConnections ? (
                <>
                  {/* Password per connection */}
                  <div className="cex-warning">
                    <Lock className="w-4 h-4" />
                    <p>
                      Passwords were not exported. Enter the database password for each connection you want to import.
                    </p>
                  </div>

                  {/* Password list */}
                  <div className="cex-preview-list">
                    {previewConnections.map((conn, i) => (
                      <div key={i} className="cex-preview-card">
                        <div className="cex-preview-head">
                          <span className="cex-preview-name">{conn.name || conn.host || conn.dbType}</span>
                          <span className="cex-type-pill">{conn.dbType}</span>
                          {conn.host && (
                            <span className="cex-preview-meta">{conn.host}:{conn.port || ""}</span>
                          )}
                        </div>
                        <div className="cex-preview-password">
                          <input
                            type={showPassword ? "text" : "password"}
                            value={passwords[i] || ""}
                            onChange={(e) => setPasswords((p) => ({ ...p, [i]: e.target.value }))}
                            placeholder="Database password (optional)"
                            className="input flex-1"
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            className="cex-mini-toggle"
                          >
                            {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {error && (
                    <div className="cex-error">
                      <AlertCircle className="w-4 h-4" />
                      <p>{error}</p>
                    </div>
                  )}
                </>
              ) : (
                <>
                  {/* File picker */}
                  <span className="cex-section-label">Source file</span>
                  <div
                    className="cex-dropzone"
                    onClick={handlePickFile}
                  >
                    <FileUp />
                    <p className="cex-dropzone-title">
                      {filePath ? filePath.split(/[/\\]/).pop() : "Click to select a .tabler-connections file"}
                    </p>
                    <p className="cex-dropzone-hint">TableR Connection File (*.tabler-connections)</p>
                  </div>

                  {filePath && (
                    <div className="cex-fieldset">
                      <div className="connection-form-field">
                        <label className="form-label uppercase tracking-wide">
                          Decryption Password <span className="text-red-400">*</span>
                        </label>
                        <div className="connection-form-password">
                          <input
                            type={showPassword ? "text" : "password"}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") void handleDecrypt(); }}
                            placeholder="Enter the export password"
                            className="input h-11 pr-11"
                            autoFocus
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
                    </div>
                  )}

                  {error && (
                    <div className="cex-error">
                      <AlertCircle className="w-4 h-4" />
                      <p>{error}</p>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
