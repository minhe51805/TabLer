import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Database, Home, RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n";

interface WorkspaceConnectingProps {
  /** Connection display name (panel title). */
  name?: string | null;
  /** Database / host / file path line shown under the name. */
  detail?: string | null;
  /**
   * When set, the SAME full-screen composition keeps its glyph + identity but
   * swaps only the area below the title: the shimmering "still connecting"
   * skeleton becomes the connection-error message plus recovery actions — so a
   * failed connect never detaches into a separate floating card.
   */
  error?: string | null;
  /** Retry / reconnect. Rendered as the primary action when `error` is set. */
  onRetry?: () => void;
  /** Return to the main launcher. The quiet escape hatch when `error` is set. */
  onGoToLauncher?: () => void;
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
}: WorkspaceConnectingProps) {
  const { t } = useI18n();
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
            <span
              className="inline-flex max-w-[280px] items-center gap-1.5 rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1 text-xs text-[var(--text-secondary)]"
              title={detailText}
            >
              <Database className="h-3 w-3 shrink-0 opacity-60" />
              <span className="truncate">{detailText}</span>
            </span>
          )}
        </div>

        {/* Below the title: loading skeleton while connecting, error + actions on failure */}
        {hasError ? (
          <div className="flex w-full flex-col items-center gap-4">
            <p className="max-h-32 overflow-y-auto text-center text-[13px] leading-relaxed text-red-500 break-words">
              {error || t("workspace.error.generic")}
            </p>
            <div className="flex w-full flex-col gap-2">
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white transition-[filter] hover:brightness-110"
                >
                  <RefreshCw className="h-4 w-4" />
                  {t("workspace.error.retry")}
                </button>
              )}
              {onGoToLauncher && (
                <button
                  type="button"
                  onClick={onGoToLauncher}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--border-color)] bg-transparent px-4 py-2.5 text-sm font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <Home className="h-4 w-4" />
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

            {/* Status footer */}
            <div className="flex w-full items-center justify-between text-[11px] font-medium text-[var(--text-secondary)] opacity-75">
              <span className="truncate">{t("workspace.connecting.checking")}</span>
              <span className="ml-3 shrink-0 tabular-nums">
                {t("workspace.connecting.elapsed", { seconds: elapsedSeconds })}
              </span>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
