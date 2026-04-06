import { useState } from "react";
import { X, Upload, CheckCircle2, AlertCircle, Lock, Eye, EyeOff, FileUp } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ConnectionConfig } from "../../types/database";
import { exportableToConnectionConfig, type ExportableConnection } from "../../utils/connection-export";

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
        filters: [{ name: "TableR Connection File", extensions: ["tablepro"] }],
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-center w-10 h-10 rounded-full bg-blue-500/10 text-blue-500">
            <Upload className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Import Connections</h2>
            <p className="text-xs text-[var(--text-muted)]">Load connections from an encrypted .tablepro file</p>
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
              <p className="text-sm font-medium text-[var(--text-primary)]">
                Successfully imported {result.count} connection{result.count !== 1 ? "s" : ""}
              </p>
              <button onClick={handleClose} className="btn btn-primary">Done</button>
            </div>
          ) : previewConnections ? (
            <>
              {/* Password per connection */}
              <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/20 flex items-start gap-2">
                <Lock className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                <p className="text-xs text-[var(--text-secondary)]">
                  Passwords were not exported. Enter the database password for each connection you want to import.
                </p>
              </div>

              {/* Preview list */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                    Connections ({selectedForImport.size}/{previewConnections.length})
                  </label>
                  <button
                    onClick={() => setSelectedForImport(
                      selectedForImport.size === previewConnections.length
                        ? new Set()
                        : new Set(previewConnections.map((_, i) => i))
                    )}
                    className="text-xs text-[var(--accent)] hover:underline"
                  >
                    {selectedForImport.size === previewConnections.length ? "Deselect All" : "Select All"}
                  </button>
                </div>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {previewConnections.map((conn, i) => (
                    <div key={i} className="border border-[var(--border)] rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedForImport.has(i)}
                          onChange={() => toggleSelect(i)}
                          className="rounded"
                        />
                        <span className="text-sm font-medium text-[var(--text-primary)]">{conn.name || conn.host || conn.dbType}</span>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">{conn.dbType}</span>
                        {conn.host && (
                          <span className="text-xs text-[var(--text-muted)]">{conn.host}:{conn.port || ""}</span>
                        )}
                      </div>
                      {selectedForImport.has(i) && (
                        <div className="flex items-center gap-2 pl-6">
                          <input
                            type={showPassword ? "text" : "password"}
                            value={passwords[i] || ""}
                            onChange={(e) => setPasswords((p) => ({ ...p, [i]: e.target.value }))}
                            placeholder="Database password (optional)"
                            className="input h-9 text-sm flex-1"
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                          >
                            {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  <p className="text-sm text-red-400">{error}</p>
                </div>
              )}
            </>
          ) : (
            <>
              {/* File picker */}
              <div
                className="border-2 border-dashed border-[var(--border)] rounded-xl p-8 text-center cursor-pointer hover:border-[var(--accent)] transition-colors"
                onClick={handlePickFile}
              >
                <FileUp className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)]" />
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  {filePath ? filePath.split(/[/\\]/).pop() : "Click to select a .tablepro file"}
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-1">TableR Connection File (*.tablepro)</p>
              </div>

              {filePath && (
                <>
                  <div className="space-y-3">
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

                  {error && (
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                      <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                      <p className="text-sm text-red-400">{error}</p>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!result && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--border)]">
            <button onClick={onClose} className="btn btn-secondary">Cancel</button>
            {previewConnections ? (
              <button
                onClick={handleImport}
                disabled={isLoading || selectedForImport.size === 0}
                className="btn btn-primary"
              >
                {isLoading ? "Importing..." : `Import ${selectedForImport.size} Connection${selectedForImport.size !== 1 ? "s" : ""}`}
              </button>
            ) : (
              <button
                onClick={() => void handleDecrypt()}
                disabled={!filePath || !password || isDecrypting}
                className="btn btn-primary"
              >
                {isDecrypting ? "Decrypting..." : "Open File"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
