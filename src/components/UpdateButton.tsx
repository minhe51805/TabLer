import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, Loader2, RefreshCw, Check, AlertCircle, ChevronRight } from "lucide-react";

interface UpdateStatus {
  available: boolean;
  version: string | null;
  body: string | null;
}

interface UpdateButtonProps {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function UpdateButton({
  variant = "secondary",
  size = "md",
  className = "",
}: UpdateButtonProps) {
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);

  const sizeClasses = {
    sm: "px-2 py-1 text-xs gap-1",
    md: "px-3 py-1.5 text-sm gap-1.5",
    lg: "px-4 py-2 text-base gap-2",
  };

  const variantClasses = {
    primary: "bg-[var(--fintech-green)] text-white hover:bg-[var(--fintech-green)]/90",
    secondary: "bg-[var(--accent-secondary)] text-[var(--text-primary)] hover:bg-[var(--accent-secondary)]/80",
    ghost: "bg-transparent text-[var(--text-secondary)] hover:bg-[var(--accent-secondary)]/50",
  };

  const handleCheckForUpdate = async () => {
    setChecking(true);
    setError(null);
    try {
      const status = await invoke<UpdateStatus>("check_for_update");
      setUpdateStatus(status);
      setDownloaded(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  };

  const handleDownloadAndInstall = async () => {
    setDownloading(true);
    setError(null);
    try {
      await invoke("download_and_install_update");
      setDownloaded(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloading(false);
    }
  };

  if (downloaded) {
    return (
      <button
        className={`inline-flex items-center ${sizeClasses[size]} ${variantClasses[variant]} rounded-md font-medium transition-colors ${className}`}
        disabled
      >
        <Check size={16} />
        <span>Update Ready - Restart to Apply</span>
      </button>
    );
  }

  if (updateStatus?.available) {
    return (
      <div className="flex items-center gap-2">
        <button
          className={`inline-flex items-center ${sizeClasses[size]} ${variantClasses["primary"]} rounded-md font-medium transition-colors ${className}`}
          onClick={handleDownloadAndInstall}
          disabled={downloading}
        >
          {downloading ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Download size={16} />
          )}
          <span>
            {downloading ? "Downloading..." : `Update to ${updateStatus.version}`}
          </span>
          <ChevronRight size={14} />
        </button>
        {error && (
          <span className="text-xs text-[var(--error)] flex items-center gap-1">
            <AlertCircle size={12} />
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        className={`inline-flex items-center ${sizeClasses[size]} ${variantClasses[variant]} rounded-md font-medium transition-colors ${className}`}
        onClick={handleCheckForUpdate}
        disabled={checking}
      >
        {checking ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <RefreshCw size={16} />
        )}
        <span>{checking ? "Checking..." : "Check for Updates"}</span>
      </button>
      {error && (
        <span className="text-xs text-[var(--error)] flex items-center gap-1">
          <AlertCircle size={12} />
          Failed to check updates
        </span>
      )}
    </div>
  );
}

