import { AlertCircle, RefreshCw, Home } from 'lucide-react';

interface Props {
  error?: Error;
  onRetry: () => void;
  onGoToLauncher: () => void;
  variant?: "overlay" | "inline";
  disableGoToLauncher?: boolean;
}

export function WorkspaceErrorFallback({
  error,
  onRetry,
  onGoToLauncher,
  variant = "overlay",
  disableGoToLauncher = false,
}: Props) {
  const isOverlay = variant === "overlay";

  return (
    <div
      className={
        isOverlay
          ? "workspace-empty fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-primary)]/92 backdrop-blur"
          : "workspace-empty w-full h-full flex items-center justify-center p-3"
      }
    >
      <div
        className={
          isOverlay
            ? "workspace-empty-panel workspace-connecting-panel w-full max-w-[360px] overflow-hidden rounded-2xl border border-[var(--border-color)]/70 bg-[var(--bg-secondary)]/95 shadow-[0_24px_60px_rgba(4,10,24,0.6)] px-6 py-5 relative"
            : "workspace-empty-panel workspace-connecting-panel w-full max-w-[260px] overflow-hidden rounded-xl border border-[var(--border-color)]/70 bg-[var(--bg-secondary)]/90 shadow-[0_14px_32px_rgba(4,10,24,0.45)] px-4 py-3.5 relative"
        }
      >
        <div className="absolute -top-12 right-6 h-24 w-24 rounded-full bg-red-500/10 blur-[60px]" />

        <div className={isOverlay ? "relative z-10 flex flex-col gap-4" : "relative z-10 flex flex-col gap-3"}>
          <div className={isOverlay ? "flex items-start gap-3" : "flex items-start gap-2.5"}>
            <div
              className={
                isOverlay
                  ? "mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl border border-red-500/20 bg-red-500/10"
                  : "mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg border border-red-500/20 bg-red-500/10"
              }
            >
              <AlertCircle className={isOverlay ? "h-5 w-5 text-red-400" : "h-4 w-4 text-red-400"} strokeWidth={2.25} />
            </div>
            <div className="flex flex-col gap-1">
              {isOverlay && (
                <span className="text-[11px] font-semibold uppercase tracking-[0.28em] text-red-400/90">Workspace issue</span>
              )}
              <h2 className={isOverlay ? "text-lg font-semibold text-[var(--text-primary)]" : "text-sm font-semibold text-[var(--text-primary)]"}>
                Workspace Error
              </h2>
              <p
                className={
                  isOverlay
                    ? "text-sm leading-relaxed text-[var(--text-secondary)]/80"
                    : "text-xs leading-relaxed text-[var(--text-secondary)]/75"
                }
              >
                {error?.message || "An unexpected error occurred while loading the workspace."}
              </p>
            </div>
          </div>

          {isOverlay && <div className="h-px w-full bg-[var(--border-color)]/60" />}

          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={onGoToLauncher}
              disabled={disableGoToLauncher}
              className={
                isOverlay
                  ? "flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-hover)] px-4 py-2.5 text-sm font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
                  : "flex w-full items-center justify-center gap-1.5 rounded-xl border border-[var(--border-color)]/70 bg-[var(--bg-tertiary)]/70 px-3 py-2.5 text-sm font-semibold text-[var(--text-primary)] shadow-sm transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
              }
            >
              <Home className={isOverlay ? "h-4 w-4" : "h-3.5 w-3.5"} />
              Go to Launcher
            </button>
            <button
              type="button"
              onClick={onRetry}
              className={
                isOverlay
                  ? "flex w-full items-center justify-center gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/20"
                  : "flex w-full items-center justify-center gap-1.5 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm font-semibold text-red-300 shadow-sm transition-colors hover:bg-red-500/20"
              }
            >
              <RefreshCw className={isOverlay ? "h-4 w-4" : "h-3.5 w-3.5"} />
              Try Again
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
