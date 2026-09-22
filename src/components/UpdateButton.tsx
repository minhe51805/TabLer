import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Download, Loader2, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";
import { useI18n } from "../i18n";
import { getAppShellCopy } from "./app-shell-copy";

import type { UpdateStatusPayload } from "../hooks/use-updater-status";

interface UpdateButtonProps {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Called after every manual check: the status payload, or null on error. */
  onChecked?: (status: UpdateStatusPayload | null) => void;
}

type UpdatePhase =
  "idle" | "checking" | "available" | "upToDate" | "downloading" | "installing" | "error";

const isDesktopWindow = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Manual "Check for updates" control (About dialog). Unlike the passive
 * topbar pill, every outcome is surfaced: up-to-date, available (version +
 * release notes + install), or the raw backend error.
 */
export function UpdateButton({
  variant = "secondary",
  size = "md",
  className = "",
  onChecked,
}: UpdateButtonProps) {
  const { language } = useI18n();
  const copy = getAppShellCopy(language).updates;
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  // Download progress events emitted by the Rust updater command.
  useEffect(() => {
    if (!isDesktopWindow()) return;
    let unlisten: UnlistenFn | null = null;
    void listen<number>("update-download-progress", (event) => {
      setProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const sizeClasses = {
    sm: "px-2 py-1 text-xs gap-1",
    md: "px-3 py-1.5 text-sm gap-1.5",
    lg: "px-4 py-2 text-base gap-2",
  };

  const variantClasses = {
    primary: "bg-[var(--fintech-green)] text-white hover:bg-[var(--fintech-green)]/90",
    secondary:
      "bg-[var(--accent-secondary)] text-[var(--text-primary)] hover:bg-[var(--accent-secondary)]/80",
    ghost: "bg-transparent text-[var(--text-secondary)] hover:bg-[var(--accent-secondary)]/50",
  };

  const buttonClass = (tone: keyof typeof variantClasses) =>
    `inline-flex items-center ${sizeClasses[size]} ${variantClasses[tone]} rounded-md font-medium transition-colors ${className}`;

  const handleCheckForUpdate = async () => {
    setPhase("checking");
    setError(null);
    setUpdateStatus(null);
    try {
      const status = await invoke<UpdateStatusPayload>("check_for_update");
      setUpdateStatus(status);
      setPhase(status.available ? "available" : "upToDate");
      onChecked?.(status);
    } catch (e) {
      setError(String(e));
      setPhase("error");
      onChecked?.(null);
    }
  };

  const handleDownloadAndInstall = async () => {
    setPhase("downloading");
    setError(null);
    setProgress(0);
    try {
      await invoke("download_and_install_update");
      setPhase("installing");
      await invoke("restart_app");
    } catch (e) {
      setError(String(e));
      setPhase("available");
    }
  };

  const busy = phase === "checking" || phase === "downloading" || phase === "installing";

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex items-center gap-2">
        {phase === "available" ? (
          <button
            type="button"
            className={buttonClass("primary")}
            onClick={handleDownloadAndInstall}
          >
            <Download size={16} />
            <span>{copy.install}</span>
          </button>
        ) : (
          <button
            type="button"
            className={buttonClass(phase === "error" ? "secondary" : variant)}
            onClick={handleCheckForUpdate}
            disabled={busy}
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            <span>
              {phase === "checking"
                ? copy.checking
                : phase === "downloading"
                  ? copy.downloading.replace("{progress}", String(progress))
                  : phase === "installing"
                    ? copy.installing
                    : phase === "error"
                      ? copy.retry
                      : copy.check}
            </span>
          </button>
        )}
        {phase === "upToDate" && (
          <span className="text-xs text-[var(--fintech-green)] flex items-center gap-1">
            <CheckCircle2 size={13} />
            {copy.upToDate}
          </span>
        )}
      </div>

      {phase === "available" && updateStatus?.version && (
        <div className="flex flex-col gap-1 max-w-md">
          <span className="text-sm text-[var(--text-primary)]">
            {copy.available.replace("{version}", updateStatus.version)}
          </span>
          {updateStatus.body && (
            <pre className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded-md border border-[var(--mm-border)] bg-[var(--mm-surface-2)] p-2 m-0">
              {updateStatus.body}
            </pre>
          )}
        </div>
      )}

      {error && (
        <span className="text-xs text-[var(--error)] flex items-start gap-1 max-w-md">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span className="break-words">
            {copy.checkFailed}: {error}
          </span>
        </span>
      )}
    </div>
  );
}
