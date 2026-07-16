import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";

import type { GlobalToastState } from "../../types/app-types";

interface GlobalToastRegionProps {
  toast: GlobalToastState | null;
  language: string;
  onDismiss: () => void;
}

export function GlobalToastRegion({ toast, language, onDismiss }: GlobalToastRegionProps) {
  if (!toast) return null;

  return (
    <div className="app-toast-region" aria-live="polite" aria-atomic="true">
      <div className={`app-toast ${toast.tone} ${toast.isClosing ? "closing" : ""}`}>
        <div className={`app-toast-icon ${toast.tone}`}>
          {toast.tone === "success" ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : toast.tone === "error" ? (
            <TriangleAlert className="h-4 w-4" />
          ) : (
            <Info className="h-4 w-4" />
          )}
        </div>
        <div className="app-toast-copy">
          <span className="app-toast-title">{toast.title}</span>
          {toast.description ? (
            <span className="app-toast-description">{toast.description}</span>
          ) : null}
        </div>
        <button
          type="button"
          className="app-toast-close"
          onClick={onDismiss}
          aria-label={language === "vi" ? "Dong thong bao" : "Dismiss notification"}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
