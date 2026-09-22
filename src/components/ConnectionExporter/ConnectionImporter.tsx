import { useMemo, useState } from "react";
import { Check, CheckCircle2, AlertCircle, Lock, Eye, EyeOff, FileUp, Package } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ExportableConnection, SkippedConnection } from "../../utils/connection-export";
import {
  importExternalConnections,
  previewExternalConnections,
} from "../../utils/connection-export";
import {
  applyUiPrefs,
  importWorkspaceBundle,
  previewWorkspaceBundle,
  type BundleItemPreview,
  type TeamBundleCounts,
  type TeamBundlePreview,
} from "../../utils/team-bundle";
import { useI18n } from "../../i18n";
import { getBundleCopy } from "./bundle-copy";
import "../../styles/lazy-overlays.css";

type BundleSectionKey = "connections" | "sqlFavorites" | "schedules" | "aiProviders" | "uiPrefs";

function bundleSections(preview: TeamBundlePreview): [BundleSectionKey, BundleItemPreview[]][] {
  return [
    ["connections", preview.connections],
    ["sqlFavorites", preview.sqlFavorites],
    ["schedules", preview.schedules],
    ["aiProviders", preview.aiProviders],
    ["uiPrefs", preview.uiPrefs],
  ];
}

interface ConnectionImporterProps {
  onImport: () => void;
  onClose: () => void;
}

export function ConnectionImporter({ onImport, onClose }: ConnectionImporterProps) {
  const { language } = useI18n();
  const bundleCopy = useMemo(() => getBundleCopy(language), [language]);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [previewConnections, setPreviewConnections] = useState<ExportableConnection[] | null>(null);
  const [selectedForImport, setSelectedForImport] = useState<Set<number>>(new Set());
  const [passwords, setPasswords] = useState<Record<number, string>>({});
  const [bundlePreview, setBundlePreview] = useState<TeamBundlePreview | null>(null);
  const [bundleSelected, setBundleSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{
    success: boolean;
    count: number;
    counts?: TeamBundleCounts;
    /** localStorage keys actually written by the UI-prefs step. */
    uiPrefsWritten?: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isBundleFile = filePath?.endsWith(".tabler-bundle") ?? false;
  /** Set when the picked file is a DBeaver/DataGrip export (.json/.xml). */
  const [externalFilePath, setExternalFilePath] = useState<string | null>(null);
  const [externalSkipped, setExternalSkipped] = useState<SkippedConnection[]>([]);

  const handlePickFile = async () => {
    setError(null);
    try {
      const picked = await open({
        multiple: false,
        filters: [
          {
            name: "TableR Export",
            extensions: ["tabler-connections", "tabler-bundle"],
          },
        ],
      });
      if (picked && typeof picked === "string") {
        setFilePath(picked);
        setPreviewConnections(null);
        setSelectedForImport(new Set());
        setBundlePreview(null);
        setBundleSelected(new Set());
        setResult(null);
        setExternalFilePath(null);
        setExternalSkipped([]);
        // Bundles carry no secrets — preview immediately, no password needed.
        if (picked.endsWith(".tabler-bundle")) {
          setIsDecrypting(true);
          try {
            const res = await previewWorkspaceBundle(picked);
            setBundlePreview(res.preview);
            const keys = new Set<string>();
            for (const [section, items] of bundleSections(res.preview)) {
              // UI prefs get one section-level checkbox, not per-key rows.
              if (section === "uiPrefs") {
                if (items.some((item) => !item.exists)) keys.add("uiPrefs");
                continue;
              }
              for (const item of items) {
                if (!item.exists) keys.add(`${section}:${item.index}`);
              }
            }
            setBundleSelected(keys);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setIsDecrypting(false);
          }
        }
      }
    } catch (e) {
      setError(`Failed to open file dialog: ${e}`);
    }
  };

  const handleBundleImport = async () => {
    if (!bundlePreview || !filePath) return;
    setIsLoading(true);
    setError(null);
    try {
      const pick = (section: string, items: BundleItemPreview[]) =>
        items.filter((item) => bundleSelected.has(`${section}:${item.index}`)).map((i) => i.index);
      const res = await importWorkspaceBundle(filePath, {
        connections: pick("connections", bundlePreview.connections),
        sqlFavorites: pick("sqlFavorites", bundlePreview.sqlFavorites),
        schedules: pick("schedules", bundlePreview.schedules),
        aiProviders: pick("aiProviders", bundlePreview.aiProviders),
        uiPrefs: bundleSelected.has("uiPrefs")
          ? bundlePreview.uiPrefs.map((item) => item.index)
          : [],
      });
      onImport();
      const counts = res.counts;
      const total = counts
        ? counts.connections + counts.sqlFavorites + counts.schedules + counts.aiProviders
        : bundleSelected.size;
      const uiPrefsWritten = res.uiPrefs ? applyUiPrefs(res.uiPrefs) : 0;
      setResult({ success: true, count: total, counts, uiPrefsWritten });
    } catch (e) {
      setError(`Import failed: ${e}`);
    } finally {
      setIsLoading(false);
    }
  };

  // DBeaver / DataGrip exports are plaintext — preview immediately, no
  // password needed. The file picker accepts .json and .xml.
  const handlePickExternalFile = async () => {
    setError(null);
    try {
      const picked = await open({
        multiple: false,
        filters: [
          {
            name: "DBeaver / DataGrip",
            extensions: ["json", "xml"],
          },
        ],
      });
      if (picked && typeof picked === "string") {
        setFilePath(null);
        setPassword("");
        setPreviewConnections(null);
        setSelectedForImport(new Set());
        setBundlePreview(null);
        setBundleSelected(new Set());
        setResult(null);
        setExternalFilePath(picked);
        setIsDecrypting(true);
        try {
          const res = await previewExternalConnections(picked);
          setPreviewConnections(res.connections);
          setExternalSkipped(res.skipped);
          setSelectedForImport(new Set(res.connections.map((_, i) => i)));
        } catch (e) {
          setExternalFilePath(null);
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setIsDecrypting(false);
        }
      }
    } catch (e) {
      setError(`Failed to open file dialog: ${e}`);
    }
  };

  const toggleBundleItem = (key: string) => {
    const next = new Set(bundleSelected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setBundleSelected(next);
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
    if (!previewConnections || (!filePath && !externalFilePath)) return;
    setIsLoading(true);
    setError(null);
    try {
      // Re-run the command with the selection so the backend persists the
      // chosen entries through ConnectionStorage (secrets go to the keyring).
      if (externalFilePath) {
        await importExternalConnections(externalFilePath, [...selectedForImport], passwords);
      } else {
        await invoke<ExportableConnection[]>("import_connections_from_file", {
          filePath,
          password,
          selectedIndices: [...selectedForImport],
          passwords,
        });
      }

      onImport();
      setResult({ success: true, count: selectedForImport.size });
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
            <h2 className="cex-title">
              {bundlePreview ? bundleCopy.import.title : "Import Connections"}
            </h2>
            <p className="cex-subtitle">
              {bundlePreview
                ? bundleCopy.import.subtitle
                : "Load connections from an encrypted TableR file"}
            </p>
          </div>
          <div className="cex-header-actions">
            {result ? (
              <button type="button" onClick={handleClose} className="cex-btn-primary">
                <Check className="w-4 h-4" />
                Done
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="cex-btn-cancel"
                  disabled={isLoading || isDecrypting}
                >
                  Cancel
                </button>
                {bundlePreview ? (
                  <button
                    type="button"
                    onClick={handleBundleImport}
                    disabled={isLoading || bundleSelected.size === 0}
                    className="cex-btn-primary"
                  >
                    {isLoading ? (
                      bundleCopy.import.working
                    ) : (
                      <>
                        <Check className="w-4 h-4" />
                        {bundleCopy.import.button} ({bundleSelected.size})
                      </>
                    )}
                  </button>
                ) : previewConnections ? (
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
                        Import {selectedForImport.size} Connection
                        {selectedForImport.size !== 1 ? "s" : ""}
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleDecrypt()}
                    disabled={!filePath || isBundleFile || !password || isDecrypting}
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
          <div className="cex-body cex-body-stacked cex-body-centered">
            <div className="cex-success">
              <CheckCircle2 />
              <p>
                {result.counts
                  ? `${bundleCopy.import.done}: ${result.counts.connections} ${bundleCopy.import.sections.connections}, ${result.counts.sqlFavorites} ${bundleCopy.import.sections.sqlFavorites}, ${result.counts.schedules} ${bundleCopy.import.sections.schedules}, ${result.counts.aiProviders} ${bundleCopy.import.sections.aiProviders}${result.uiPrefsWritten ? `, ${result.uiPrefsWritten} ${bundleCopy.import.uiPrefsWritten} — ${bundleCopy.import.uiPrefsRestart}` : ""}`
                  : `Successfully imported ${result.count} connection${result.count !== 1 ? "s" : ""}`}
              </p>
              <button onClick={handleClose} className="btn btn-primary">
                Done
              </button>
            </div>
          </div>
        ) : bundlePreview ? (
          <div className="cex-body cex-body-stacked">
            <div className="cex-warning">
              <Package className="w-4 h-4" />
              <p>{bundleCopy.export.info}</p>
            </div>

            <div className="cex-preview-list">
              {bundleSections(bundlePreview).map(([section, items]) => {
                if (items.length === 0) return null;
                // UI prefs collapse into one section-level checkbox: the
                // backend returns only missing keys and the frontend writes
                // them back, so per-key rows would just be noise.
                if (section === "uiPrefs") {
                  const existing = items.filter((item) => item.exists).length;
                  const allExist = existing === items.length;
                  return (
                    <div key={section} className="cex-bundle-section">
                      <label
                        className={`cex-preview-card cex-bundle-item ${allExist ? "is-existing" : ""}`}
                      >
                        <div className="cex-preview-head">
                          <input
                            type="checkbox"
                            checked={bundleSelected.has("uiPrefs")}
                            disabled={allExist}
                            onChange={() => toggleBundleItem("uiPrefs")}
                          />
                          <span className="cex-preview-name">
                            {bundleCopy.import.sections.uiPrefs}
                          </span>
                          <span className="cex-preview-meta">
                            {bundleCopy.import.uiPrefsMeta
                              .replace("{total}", String(items.length))
                              .replace("{existing}", String(existing))}
                          </span>
                          {allExist && (
                            <span className="cex-type-pill">{bundleCopy.import.exists}</span>
                          )}
                        </div>
                      </label>
                    </div>
                  );
                }
                return (
                  <div key={section} className="cex-bundle-section">
                    <span className="cex-section-label">
                      {bundleCopy.import.sections[section]} ({items.length})
                    </span>
                    {items.map((item) => {
                      const key = `${section}:${item.index}`;
                      return (
                        <label
                          key={key}
                          className={`cex-preview-card cex-bundle-item ${item.exists ? "is-existing" : ""}`}
                        >
                          <div className="cex-preview-head">
                            <input
                              type="checkbox"
                              checked={bundleSelected.has(key)}
                              disabled={item.exists}
                              onChange={() => toggleBundleItem(key)}
                            />
                            <span className="cex-preview-name">{item.name || item.id}</span>
                            {item.detail && <span className="cex-preview-meta">{item.detail}</span>}
                            {item.exists && (
                              <span className="cex-type-pill">{bundleCopy.import.exists}</span>
                            )}
                            {!item.exists && item.needsPassword && (
                              <span className="cex-type-pill cex-pill-warn">
                                {bundleCopy.import.needsPassword}
                              </span>
                            )}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                );
              })}
              {bundleSections(bundlePreview).every(([, items]) => items.length === 0) && (
                <p className="cex-rail-empty">{bundleCopy.import.empty}</p>
              )}
            </div>

            {error && (
              <div className="cex-error">
                <AlertCircle className="w-4 h-4" />
                <p>{error}</p>
              </div>
            )}
          </div>
        ) : previewConnections ? (
          <div className="cex-body cex-body-stacked">
            {/* Password per connection */}
            <div className="cex-warning">
              <Lock className="w-4 h-4" />
              <p>
                {externalFilePath
                  ? bundleCopy.import.external.passwordNote
                  : "Passwords were not exported. Enter the database password for each connection you want to import."}
              </p>
            </div>

            {externalSkipped.length > 0 && (
              <div className="cex-warning">
                <AlertCircle className="w-4 h-4" />
                <p>
                  {bundleCopy.import.external.skipped.replace(
                    "{count}",
                    String(externalSkipped.length),
                  )}
                  {": "}
                  {externalSkipped.map((s) => `${s.name} (${s.reason})`).join(", ")}
                </p>
              </div>
            )}

            {/* Password list */}
            <div className="cex-preview-list">
              {previewConnections.map((conn, i) => (
                <div key={i} className="cex-preview-card">
                  <div className="cex-preview-head">
                    <input
                      type="checkbox"
                      checked={selectedForImport.has(i)}
                      onChange={() => toggleSelect(i)}
                    />
                    <span className="cex-preview-name">
                      {conn.name || conn.host || conn.dbType}
                    </span>
                    <span className="cex-type-pill">{conn.dbType}</span>
                    {conn.host && (
                      <span className="cex-preview-meta">
                        {conn.host}:{conn.port || ""}
                      </span>
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
                      {showPassword ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
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
          </div>
        ) : (
          <div className="cex-body cex-body-stacked">
            <>
              {/* File picker */}
              <span className="cex-section-label">Source file</span>
              <div className="cex-dropzone" onClick={handlePickFile}>
                <FileUp />
                <p className="cex-dropzone-title">
                  {filePath
                    ? filePath.split(/[/\\]/).pop()
                    : "Click to select a .tabler-connections or .tabler-bundle file"}
                </p>
                <p className="cex-dropzone-hint">{bundleCopy.import.dropzoneHint}</p>
              </div>

              {/* External tool import (DBeaver / DataGrip) */}
              <button
                type="button"
                onClick={() => void handlePickExternalFile()}
                disabled={isDecrypting}
                className="cex-btn-cancel"
                style={{ alignSelf: "flex-start" }}
              >
                <FileUp className="w-4 h-4" />
                {isDecrypting ? "Reading file..." : bundleCopy.import.external.button}
              </button>

              {filePath && !isBundleFile && (
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
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleDecrypt();
                        }}
                        placeholder="Enter the export password"
                        className="input h-11 pr-11"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="connection-form-password-toggle"
                      >
                        {showPassword ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
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
          </div>
        )}
      </div>
    </div>
  );
}
