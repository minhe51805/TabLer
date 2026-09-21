import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useI18n } from "../i18n";
import { getAppShellCopy } from "./app-shell-copy";

export interface StorageFileIssue {
  file: string;
  error: string;
}

export interface StorageHealthReport {
  healthy: boolean;
  issues: StorageFileIssue[];
}

interface StorageRecoveryDialogProps {
  report: StorageHealthReport;
}

/**
 * Startup gate shown when persisted workspace files fail to parse. "Reset &
 * continue" quarantines each corrupt file as `<name>.corrupt-<timestamp>` and
 * relaunches into a clean workspace; "Quit" exits so the user can inspect the
 * files manually.
 */
export function StorageRecoveryDialog({ report }: StorageRecoveryDialogProps) {
  const { language } = useI18n();
  const copy = getAppShellCopy(language).storageRecovery;
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const handleReset = async () => {
    if (resetting) return;
    setResetting(true);
    setResetError(null);
    try {
      await invoke("reset_corrupt_storage", {
        files: report.issues.map((issue) => issue.file),
      });
      await invoke("restart_app");
    } catch (error) {
      setResetting(false);
      setResetError(String(error));
    }
  };

  const handleQuit = () => {
    void invoke("exit_app", { code: 0 }).catch(() => {
      // If the command is unavailable (e.g. stale frontend bundle), fall back
      // to closing the window.
      window.close();
    });
  };

  return (
    <div className="boot-failure-screen">
      <div className="boot-failure-card storage-recovery-card">
        <div className="boot-failure-kicker">{copy.kicker}</div>
        <h1 className="boot-failure-title">
          <AlertTriangle size={22} className="storage-recovery-title-icon" />
          {copy.title}
        </h1>
        <p className="boot-failure-description">{copy.description}</p>

        <div className="storage-recovery-files">
          <span className="storage-recovery-files-label">{copy.affectedFiles}</span>
          <ul className="storage-recovery-file-list">
            {report.issues.map((issue) => (
              <li key={issue.file} className="storage-recovery-file">
                <code>{issue.file}</code>
                <span className="storage-recovery-file-error">{issue.error}</span>
              </li>
            ))}
          </ul>
        </div>

        {resetError && (
          <div className="boot-failure-error-box">
            {copy.resetFailed}: {resetError}
          </div>
        )}

        <div className="storage-recovery-actions">
          <button
            type="button"
            className="storage-recovery-btn storage-recovery-btn-primary"
            onClick={handleReset}
            disabled={resetting}
          >
            {resetting && <Loader2 size={14} className="animate-spin" />}
            {resetting ? copy.resetting : copy.reset}
          </button>
          <button
            type="button"
            className="storage-recovery-btn storage-recovery-btn-secondary"
            onClick={handleQuit}
            disabled={resetting}
          >
            {copy.quit}
          </button>
        </div>
      </div>
    </div>
  );
}
