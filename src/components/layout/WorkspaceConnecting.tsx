import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Database, Home, RefreshCw, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { getConnectionErrorCopy } from "../connection-error-copy";
import type { ConnectionErrorDetails } from "../../utils/connection-error";

interface WorkspaceConnectingProps {
  /** Connection display name (panel title). */
  name?: string | null;
  /** Database / host / file path line shown under the name. */
  detail?: string | null;
  /**
   * When set, the SAME full-screen composition keeps its glyph + identity but
   * swaps only the area below the title: the shimmering "still connecting"
   * skeleton becomes the classified connection error (stage badge + message +
   * hint) plus recovery actions — so a failed connect never detaches into a
   * separate floating card.
   */
  error?: ConnectionErrorDetails | null;
  /** Retry / reconnect. Rendered as the primary action when `error` is set. */
  onRetry?: () => void;
  /** Return to the main launcher. The quiet escape hatch when `error` is set. */
  onGoToLauncher?: () => void;
  /**
   * Abort the in-progress connection and return to the launcher. Rendered as a
   * quiet button under the skeleton while still connecting (before any `error`).
   */
  onCancel?: () => void;
}

/**
 * Full-screen "checking that the database is reachable" state shown while a
 * saved connection is being established. Borderless centered composition:
 * a database glyph with orbiting satellites, connection identity, and — below
 * the title — either shimmering skeleton rows (the workspace "materialising")
 * while connecting, or, once the attempt fails, the error message with Try
 * Again + Go to Launcher actions. The header stays put so the user keeps their
 * context instead of being thrown to a disconnected error card.
 */
export function WorkspaceConnecting({
  name,
  detail,
  error,
  onRetry,
  onGoToLauncher,
  onCancel,
}: WorkspaceConnectingProps) {
  const { t, language } = useI18n();
  const errorCopy = getConnectionErrorCopy(language);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const hasError = Boolean(error);

  useEffect(() => {
    // Freeze the elapsed counter once we surface an error: it is no longer
    // "still connecting", so a ticking timer would be misleading.
    if (hasError) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasError]);

  const displayName = name || t("workspace.ready.connectedWorkspace");
  const detailText = detail || "";

  // Portal to <body> so the fixed overlay always covers the entire window —
  // ancestors inside the workspace layout create containing blocks that would
  // otherwise confine `position: fixed` to the right-hand pane.
  return createPortal(
    <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-[var(--bg-primary)]">
      <div className="flex w-full max-w-[340px] flex-col items-center gap-6 px-6">
        {/* Orbiting database glyph */}
        <div className="workspace-connecting-orbit" aria-hidden="true">
          <span className="workspace-connecting-orbit-ring workspace-connecting-orbit-ring--outer" />
          <span className="workspace-connecting-orbit-ring workspace-connecting-orbit-ring--inner" />
          <div className="workspace-connecting-orbit-core">
            <Database className="h-5 w-5" strokeWidth={2} />
          </div>
        </div>

        {/* Connection identity */}
        <div className="flex w-full flex-col items-center gap-1.5 text-center">
          <span className="text-[10px] font-bold uppercase tracking-[0.24em] text-[var(--accent)] opacity-80">
            {t("workspace.connecting.kicker")}
          </span>
          <h2
            className="w-full max-w-[280px] truncate text-xl font-bold text-[var(--text-primary)]"
            title={displayName}
          >
            {displayName}
          </h2>
          {detailText && (
            <span className="workspace-connecting-detail" title={detailText}>
              <Database />
              <span className="workspace-connecting-detail-label">{detailText}</span>
            </span>
          )}
        </div>

        {hasError ? (
          <div className="flex w-full flex-col items-center gap-4">
            <div className="flex w-full flex-col items-center gap-2">
              {error?.stage ? (
                <span className="workspace-connecting-stage">
                  {errorCopy.stageLabels[error.stage] ?? errorCopy.stageLabels.unknown}
                </span>
              ) : null}
              <p className="max-h-32 overflow-y-auto text-center text-[13px] leading-relaxed text-red-500 break-words">
                {error?.message || t("workspace.error.generic")}
              </p>
              {error?.hint ? (
                <p className="workspace-connecting-hint">
                  <strong>{errorCopy.hintLabel}:</strong> {error.hint}
                </p>
              ) : null}
            </div>
            <div className="flex w-full gap-2">
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="workspace-connecting-action workspace-connecting-action--primary"
                >
                  <RefreshCw />
                  {t("workspace.error.retry")}
                </button>
              )}
              {onGoToLauncher && (
                <button
                  type="button"
                  onClick={onGoToLauncher}
                  className="workspace-connecting-action workspace-connecting-action--secondary"
                >
                  <Home />
                  {t("workspace.error.goLauncher")}
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Shimmering skeleton rows — the workspace materialising */}
            <div className="flex w-full flex-col gap-2.5" aria-hidden="true">
              <div className="workspace-connecting-skeleton-bar" style={{ width: "92%" }} />
              <div className="workspace-connecting-skeleton-bar" style={{ width: "74%" }} />
              <div className="workspace-connecting-skeleton-bar" style={{ width: "84%" }} />
            </div>

            {/* Status footer + quiet cancel action */}
            <div className="flex w-full flex-col items-center gap-4">
              <div className="flex w-full items-center justify-between text-[11px] font-medium text-[var(--text-secondary)] opacity-75">
                <span className="truncate">{t("workspace.connecting.checking")}</span>
                <span className="ml-3 shrink-0 tabular-nums">
                  {t("workspace.connecting.elapsed", { seconds: elapsedSeconds })}
                </span>
              </div>

              {onCancel && (
                <button type="button" onClick={onCancel} className="workspace-connecting-cancel">
                  <X />
                  {t("workspace.connecting.cancel")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
