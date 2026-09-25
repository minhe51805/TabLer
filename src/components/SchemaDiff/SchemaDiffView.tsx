import { useEffect } from "react";
import { X } from "lucide-react";
import { useI18n } from "../../i18n";
import { useSchemaDiffStore } from "../../stores/schemaDiffStore";
import { getSchemaDiffCopy } from "./schema-diff-copy";
import { trackUsage } from "../../utils/usage-counter";
import { SchemaDiffPanel } from "./SchemaDiffPanel";

/**
 * Schema Diff & migration tool (roadmap Phase 2A, Tools → Schema Diff).
 * Standalone modal host for SchemaDiffPanel — the same panel is embedded in
 * the Review Center's "Schema diff" tab.
 */
export function SchemaDiffView() {
  const isOpen = useSchemaDiffStore((state) => state.isOpen);
  const close = useSchemaDiffStore((state) => state.close);
  const { language } = useI18n();
  const copy = getSchemaDiffCopy(language);

  // Open via Command Palette / menu event.
  useEffect(() => {
    const open = () => useSchemaDiffStore.getState().open();
    window.addEventListener("open-schema-diff-palette", open);
    return () => window.removeEventListener("open-schema-diff-palette", open);
  }, []);

  // Local usage counter: one count per open, not per render.
  useEffect(() => {
    if (isOpen) trackUsage("diff.schema");
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="qs-overlay" role="presentation">
      <div className="qs-panel schema-diff-panel" role="dialog" aria-label={copy.title}>
        <div className="qs-input-row">
          <strong>{copy.title}</strong>
          <button type="button" className="qs-clear-btn" aria-label={copy.close} onClick={close}>
            <X size={14} />
          </button>
        </div>
        <SchemaDiffPanel />
      </div>
    </div>
  );
}
