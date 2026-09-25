import { useMemo, useState } from "react";
import { Check, CheckCircle2, AlertCircle, Lock, Eye, EyeOff, Package } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import type { ConnectionConfig } from "../../types/database";
import { exportConnections } from "../../utils/connection-export";
import { exportWorkspaceBundle } from "../../utils/team-bundle";
import { useI18n } from "../../i18n";
import { getBundleCopy } from "./bundle-copy";
import "../../styles/lazy-overlays.css";

interface ConnectionExporterProps {
  connections: ConnectionConfig[];
  onClose: () => void;
}

export function ConnectionExporter({ connections, onClose }: ConnectionExporterProps) {
  const { language } = useI18n();
  const bundleCopy = useMemo(() => getBundleCopy(language), [language]);
  const [mode, setMode] = useState<"connections" | "bundle">("connections");
  const [bundleEncrypt, setBundleEncrypt] = useState(false);
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
      setError(bundleCopy.connectionsExport.errorPasswordShort);
      return;
    }
    if (password !== confirmPassword) {
      setError(bundleCopy.connectionsExport.errorPasswordMismatch);
      return;
    }
    if (selected.size === 0) {
      setError(bundleCopy.connectionsExport.errorNoSelection);
      return;
    }

    setIsExporting(true);
    const toExport = connections.filter((c) => selected.has(c.id));
    const res = await exportConnections(toExport, password);
    setIsExporting(false);

    if (res.success) {
      setResult({
        success: true,
        message: bundleCopy.connectionsExport.done(selected.size, res.filePath ?? ""),
      });
    } else if (res.error) {
      setError(res.error);
    }
  };

  const handleBundleExport = async () => {
    setError(null);
    if (bundleEncrypt) {
      if (password.length < 10) {
        setError(bundleCopy.connectionsExport.errorPasswordShort);
        return;
      }
      if (password !== confirmPassword) {
        setError(bundleCopy.connectionsExport.errorPasswordMismatch);
        return;
      }
    }
    try {
      const path = await save({
        defaultPath: bundleEncrypt ? "workspace.tabler-bundle.texp" : "workspace.tabler-bundle",
        filters: bundleEncrypt
          ? [{ name: "Encrypted TableR Export", extensions: ["texp"] }]
          : [{ name: "TableR Workspace Bundle", extensions: ["tabler-bundle"] }],
      });
      if (!path) return;
      setIsExporting(true);
      const written = await exportWorkspaceBundle(path, bundleEncrypt ? password : undefined);
      setResult({ success: true, message: `${bundleCopy.export.done} ${written}` });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsExporting(false);
    }
  };

  const handleClose = () => {
    if (result?.success) onClose();
  };

  // Backdrop dismiss mirrors the other modals; it stays inert while an
  // export is in flight so a stray click cannot abandon the write.
  const handleBackdropClick = () => {
    if (isExporting) return;
    if (result && !result.success) return;
    onClose();
  };

  return (
    <div className="cex-backdrop" onClick={handleBackdropClick}>
      <div className="cex-modal" onClick={(event) => event.stopPropagation()}>
        {/* Header */}
        <div className="cex-header">
          <div className="cex-header-copy">
            <h2 className="cex-title">
              {mode === "bundle" ? bundleCopy.export.title : bundleCopy.connectionsExport.title}
            </h2>
            <p className="cex-subtitle">
              {mode === "bundle"
                ? bundleCopy.export.subtitle
                : bundleCopy.connectionsExport.subtitle}
            </p>
          </div>
          <div className="cex-header-actions">
            {result ? (
              <button type="button" onClick={handleClose} className="cex-btn-primary">
                <Check className="w-4 h-4" />
                {bundleCopy.common.done}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="cex-btn-cancel"
                  disabled={isExporting}
                >
                  {bundleCopy.common.cancel}
                </button>
                <button
                  type="button"
                  onClick={mode === "bundle" ? handleBundleExport : handleExport}
                  disabled={
                    isExporting || (mode === "connections" && (selected.size === 0 || !password))
                  }
                  className="cex-btn-primary"
                >
                  {isExporting ? (
                    mode === "bundle" ? (
                      bundleCopy.export.working
                    ) : (
                      bundleCopy.connectionsExport.working
                    )
                  ) : mode === "bundle" ? (
                    <>
                      <Package className="w-4 h-4" />
                      {bundleCopy.export.button}
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4" />
                      {bundleCopy.connectionsExport.button(selected.size)}
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Mode switch */}
        {!result && (
          <div className="cex-mode-switch">
            <button
              type="button"
              className={`cex-mode-btn ${mode === "connections" ? "is-active" : ""}`}
              onClick={() => setMode("connections")}
            >
              {bundleCopy.modes.connections}
            </button>
            <button
              type="button"
              className={`cex-mode-btn ${mode === "bundle" ? "is-active" : ""}`}
              onClick={() => setMode("bundle")}
            >
              <Package className="w-3.5 h-3.5" />
              {bundleCopy.modes.bundle}
            </button>
          </div>
        )}

        {/* Body */}
        {result ? (
          <div className="cex-body cex-body-centered">
            <div className="cex-success">
              <CheckCircle2 />
              <p>{result.message}</p>
              <button onClick={handleClose} className="btn btn-primary">
                {bundleCopy.common.done}
              </button>
            </div>
          </div>
        ) : mode === "bundle" ? (
          <div className="cex-body cex-body-stacked">
            <div className="cex-warning">
              <Package className="w-4 h-4" />
              <p>{bundleCopy.export.info}</p>
            </div>
            <div className="cex-bundle-includes">
              <span className="cex-section-label">{bundleCopy.export.includes}</span>
              <ul>
                <li>{bundleCopy.export.connections}</li>
                <li>{bundleCopy.export.favorites}</li>
                <li>{bundleCopy.export.schedules}</li>
                <li>{bundleCopy.export.aiProviders}</li>
                <li>{bundleCopy.export.uiPrefs}</li>
              </ul>
            </div>
            <label className="export-encrypt-toggle">
              <input
                type="checkbox"
                checked={bundleEncrypt}
                onChange={(e) => {
                  setBundleEncrypt(e.target.checked);
                  setError(null);
                }}
              />
              <span>{bundleCopy.export.encryptLabel}</span>
            </label>
            {bundleEncrypt && (
              <div className="cex-fieldset">
                <p className="export-encrypt-note">{bundleCopy.export.encryptNote}</p>
                <div className="connection-form-field">
                  <label className="form-label uppercase tracking-wide">
                    {bundleCopy.connectionsExport.passwordLabel}{" "}
                    <span className="text-red-400">*</span>
                  </label>
                  <div className="connection-form-password">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={bundleCopy.connectionsExport.passwordPlaceholder}
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
                    {bundleCopy.connectionsExport.confirmLabel}{" "}
                    <span className="text-red-400">*</span>
                  </label>
                  <input
                    type={showPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={bundleCopy.connectionsExport.confirmPlaceholder}
                    className="input h-11"
                    minLength={10}
                  />
                </div>
              </div>
            )}
            {error && (
              <div className="cex-error">
                <AlertCircle className="w-4 h-4" />
                <p>{error}</p>
              </div>
            )}
          </div>
        ) : (
          <div className="cex-body">
            {/* Left rail: connection selection */}
            <aside className="cex-rail">
              <div className="cex-rail-head">
                <label className="cex-section-label">
                  {bundleCopy.connectionsExport.selectLabel(selected.size, connections.length)}
                </label>
                <button onClick={toggleAll} className="cex-toggle-all">
                  {selected.size === connections.length
                    ? bundleCopy.connectionsExport.deselectAll
                    : bundleCopy.connectionsExport.selectAll}
                </button>
              </div>
              <div className="cex-rail-list">
                {connections.length === 0 ? (
                  <p className="cex-rail-empty">{bundleCopy.connectionsExport.empty}</p>
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
                      <span className="cex-rail-item-name">
                        {conn.name || conn.host || conn.db_type}
                      </span>
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
                <p>{bundleCopy.connectionsExport.encryptionNote}</p>
              </div>

              <div className="cex-fieldset">
                <div className="connection-form-field">
                  <label className="form-label uppercase tracking-wide">
                    {bundleCopy.connectionsExport.passwordLabel}{" "}
                    <span className="text-red-400">*</span>
                  </label>
                  <div className="connection-form-password">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={bundleCopy.connectionsExport.passwordPlaceholder}
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
                    {bundleCopy.connectionsExport.confirmLabel}{" "}
                    <span className="text-red-400">*</span>
                  </label>
                  <input
                    type={showPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={bundleCopy.connectionsExport.confirmPlaceholder}
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
