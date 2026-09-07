import { LoaderCircle } from "lucide-react";

export function WorkspaceBootFallback() {
  return (
    <div className="workspace-empty fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-primary)]">
      <div className="workspace-empty-panel workspace-connecting-panel max-w-[340px] flex flex-col items-center justify-center overflow-hidden border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl p-8 rounded-2xl mx-4 relative">
        {/* Ambient animated glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[120px] h-[120px] bg-[var(--accent)]/10 rounded-full blur-[60px] animate-pulse"></div>

        <div className="workspace-empty-hero w-full flex flex-col items-center justify-center gap-6 relative z-10 m-0 p-0">
          <div className="w-14 h-14 rounded-full border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-sm flex items-center justify-center">
            <LoaderCircle className="w-6 h-6 text-[var(--accent)] animate-spin" strokeWidth={2.5} />
          </div>

          <div className="workspace-empty-copy flex flex-col items-center w-full text-center gap-1.5 m-0 p-0">
            <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-[var(--accent)] opacity-80">WORKSPACE</span>
            <h2 className="text-xl font-bold text-[var(--text-primary)] truncate w-full max-w-[280px]">
              Loading workspace shell
            </h2>
            <p className="text-sm text-[var(--text-secondary)] opacity-70 w-full max-w-[280px]">
              Preparing panels, editors, and database tools.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
