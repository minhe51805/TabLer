import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, FileWarning, Loader2, ShieldCheck, X } from "lucide-react";

interface DiagnosticPreview {
  reviewId: string;
  expiresAt: string;
  categories: string[];
  logEntries: number;
  estimatedBytes: number;
  excluded: string[];
}

export function DiagnosticBundleModal({ onClose }: { onClose: () => void }) {
  const [preview, setPreview] = useState<DiagnosticPreview | null>(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  const loadPreview = useCallback(async () => {
    setPreview(null);
    setError("");
    try {
      setPreview(await invoke<DiagnosticPreview>("preview_diagnostic_bundle"));
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const exportBundle = async () => {
    if (!preview || exporting) return;
    setExporting(true);
    setError("");
    try {
      const path = await invoke<string | null>("export_diagnostic_bundle", {
        reviewId: preview.reviewId,
      });
      if (path) onClose();
      else {
        setExporting(false);
        await loadPreview();
      }
    } catch (reason) {
      setError(String(reason));
      setExporting(false);
    }
  };

  return (
    <div className="app-help-modal-backdrop diagnostic-review-backdrop" onClick={onClose}>
      <div className="app-help-modal diagnostic-review-modal" onClick={(event) => event.stopPropagation()}>
        <div className="app-help-modal-header">
          <div className="app-help-modal-copy">
            <span className="app-help-modal-kicker">Privacy review</span>
            <h3 className="app-help-modal-title">Export diagnostic bundle</h3>
            <p className="app-help-modal-description">
              Review exactly what TableR will include before choosing where to save the file.
            </p>
          </div>
          <button type="button" className="app-help-modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {!preview && !error && (
          <div className="diagnostic-review-loading">
            <Loader2 size={18} className="animate-spin" /> Preparing redacted preview...
          </div>
        )}

        {preview && (
          <div className="diagnostic-review-content">
            <section>
              <h4><FileWarning size={16} /> Included</h4>
              {preview.categories.map((category) => (
                <div className="diagnostic-review-row" key={category}>
                  <Check size={14} /> <span>{category}</span>
                </div>
              ))}
              <p>{preview.logEntries.toLocaleString()} log entries, approximately {Math.ceil(preview.estimatedBytes / 1024)} KB.</p>
            </section>
            <section>
              <h4><ShieldCheck size={16} /> Always excluded</h4>
              {preview.excluded.map((category) => (
                <div className="diagnostic-review-row" key={category}>
                  <ShieldCheck size={14} /> <span>{category}</span>
                </div>
              ))}
            </section>
          </div>
        )}

        {error && <div className="diagnostic-review-error" role="alert">{error}</div>}

        <div className="app-help-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!preview || exporting} onClick={() => void exportBundle()}>
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <FileWarning size={15} />}
            Choose location and export
          </button>
        </div>
      </div>
    </div>
  );
}
