import { AlertCircle, RefreshCw, Home } from "lucide-react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";

interface Props {
  error?: Error;
  onRetry: () => void;
  onGoToLauncher: () => void;
  variant?: "overlay" | "inline";
  disableGoToLauncher?: boolean;
}

/**
 * Workspace failure card. Redesigned: soft red header badge, technical error
 * message in a monospace block, and a clear action hierarchy — "Try Again"
 * is the solid primary action, "Go to Launcher" is the quiet escape hatch.
 */
export function WorkspaceErrorFallback({
  error,
  onRetry,
  onGoToLauncher,
  variant = "overlay",
  disableGoToLauncher = false,
}: Props) {
  const { t } = useI18n();
  const isOverlay = variant === "overlay";
  const message = error?.message || t("workspace.error.generic");

  const card = (
    <div
      className={
        isOverlay
          ? "relative w-full max-w-[380px] overflow-hidden rounded-2xl border border-[var(--border-color)]/70 bg-[var(--bg-secondary)]/95 px-6 py-6 shadow-[0_24px_60px_rgba(4,10,24,0.6)]"
          : "relative w-full max-w-[300px] overflow-hidden rounded-2xl border border-[var(--border-color)]/70 bg-[var(--bg-secondary)]/90 px-5 py-5 shadow-[0_14px_32px_rgba(4,10,24,0.45)]"
      }
    >
        <div className="pointer-events-none absolute -top-12 right-6 h-24 w-24 rounded-full bg-red-500/10 blur-[60px]" />

        <div className={isOverlay ? "relative z-10 flex flex-col gap-4" : "relative z-10 flex flex-col gap-3"}>
          {/* Header */}
          <div className={isOverlay ? "flex items-start gap-3" : "flex items-start gap-2.5"}>
            <div
              className={
                isOverlay
                  ? "mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-red-500/20 bg-red-500/10"
                  : "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-red-500/20 bg-red-500/10"
              }
            >
              <AlertCircle
                className={isOverlay ? "h-5 w-5 text-red-400" : "h-4 w-4 text-red-400"}
                strokeWidth={2.25}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.28em] text-red-400/90">
                {t("workspace.error.kicker")}
              </span>
              <h2
                className={
                  isOverlay
                    ? "text-lg font-semibold text-[var(--text-primary)]"
                    : "text-base font-semibold text-[var(--text-primary)]"
                }
              >
                {t("workspace.error.title")}
              </h2>
            </div>
          </div>

          {/* Technical message in a monospace block */}
          <div
            className={
              isOverlay
                ? "max-h-28 overflow-y-auto rounded-lg border border-[var(--border-color)]/70 bg-[var(--bg-primary)]/80 px-3 py-2.5 font-mono text-xs leading-relaxed text-[var(--text-secondary)] break-words"
                : "max-h-24 overflow-y-auto rounded-lg border border-[var(--border-color)]/60 bg-[var(--bg-primary)]/80 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)] break-words"
            }
          >
            {message}
          </div>

          {isOverlay && <div className="h-px w-full bg-[var(--border-color)]/60" />}

          {/* Actions: retry is primary, launcher is the quiet exit */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={onRetry}
              className={
                isOverlay
                  ? "flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white transition-[filter] hover:brightness-110"
                  : "flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)] px-3 py-2.5 text-sm font-semibold text-white transition-[filter] hover:brightness-110"
              }
            >
              <RefreshCw className={isOverlay ? "h-4 w-4" : "h-3.5 w-3.5"} />
              {t("workspace.error.retry")}
            </button>
            <button
              type="button"
              onClick={onGoToLauncher}
              disabled={disableGoToLauncher}
              className={
                isOverlay
                  ? "flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--border-color)] bg-transparent px-4 py-2.5 text-sm font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                  : "flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--border-color)]/70 bg-transparent px-3 py-2 text-xs font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
              }
            >
              <Home className={isOverlay ? "h-4 w-4" : "h-3.5 w-3.5"} />
              {t("workspace.error.goLauncher")}
            </button>
          </div>
        </div>
      </div>
  );

  if (isOverlay) {
    // Portal to <body>: ancestors in the workspace layout create containing
    // blocks that would otherwise confine `position: fixed` to one pane.
    return createPortal(
      <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-[var(--bg-primary)]/92 backdrop-blur">
        {card}
      </div>,
      document.body,
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center p-3">
      {card}
    </div>
  );
}
