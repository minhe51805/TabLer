import { AlertCircle, RefreshCw, Home } from 'lucide-react';

interface Props {
  error?: Error;
  onRetry: () => void;
  onGoToLauncher: () => void;
}

export function WorkspaceErrorFallback({ error, onRetry, onGoToLauncher }: Props) {
  return (
    <div className="workspace-empty fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-primary)]">
      <div className="workspace-empty-panel workspace-connecting-panel max-w-[380px] flex flex-col items-center justify-center overflow-hidden border border-red-500/20 bg-[var(--bg-secondary)] shadow-2xl p-8 rounded-2xl mx-4 relative">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[120px] h-[120px] bg-red-500/10 rounded-full blur-[60px] animate-pulse"></div>

        <div className="workspace-empty-hero w-full flex flex-col items-center justify-center gap-6 relative z-10 m-0 p-0">
          <div className="w-14 h-14 rounded-full border border-red-500/30 bg-red-500/10 shadow-sm flex items-center justify-center">
            <AlertCircle className="w-6 h-6 text-red-500" strokeWidth={2.5} />
          </div>

          <div className="workspace-empty-copy flex flex-col items-center w-full text-center gap-1.5 m-0 p-0">
            <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-red-500 opacity-80">ERROR</span>
            <h2 className="text-xl font-bold text-[var(--text-primary)] w-full">
              Workspace Error
            </h2>
            <p className="text-sm text-[var(--text-secondary)] opacity-70 w-full max-w-[280px]">
              {error?.message || "An unexpected error occurred while loading the workspace."}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-center gap-3 mt-8 relative z-10 w-full">
          <button onClick={onRetry} className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 text-sm font-semibold rounded-lg transition-colors border border-red-500/20">
            <RefreshCw className="w-4 h-4" />
            Try Again
          </button>
          <button onClick={onGoToLauncher} className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 bg-[var(--bg-hover)] hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm font-semibold rounded-lg transition-colors border border-[var(--border-color)]">
            <Home className="w-4 h-4" />
            Go to Launcher
          </button>
        </div>
      </div>
    </div>
  );
}