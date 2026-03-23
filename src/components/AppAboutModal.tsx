import { X } from "lucide-react";
import { useI18n } from "../i18n";

interface AppAboutModalProps {
  onClose: () => void;
}

export function AppAboutModal({ onClose }: AppAboutModalProps) {
  const { t } = useI18n();

  return (
    <div className="app-help-modal-backdrop" onClick={onClose}>
      <div className="app-help-modal" onClick={(event) => event.stopPropagation()}>
        <div className="app-help-modal-header">
          <div className="app-help-modal-copy">
            <span className="app-help-modal-kicker">{t("help.about.kicker")}</span>
            <h3 className="app-help-modal-title">{t("help.about.title")}</h3>
            <p className="app-help-modal-description">{t("help.about.description")}</p>
          </div>
          <button
            type="button"
            className="app-help-modal-close"
            onClick={onClose}
            aria-label={t("common.cancel")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="app-help-modal-grid">
          <div className="app-help-modal-metric">
            <span className="app-help-modal-metric-label">{t("help.about.version")}</span>
            <strong className="app-help-modal-metric-value">0.1.0</strong>
          </div>
          <div className="app-help-modal-metric">
            <span className="app-help-modal-metric-label">{t("help.about.build")}</span>
            <strong className="app-help-modal-metric-value">desktop</strong>
          </div>
        </div>

        <div className="app-help-modal-section">
          <span className="app-help-modal-section-label">{t("help.about.modules")}</span>
          <div className="app-help-modal-tags">
            <span className="app-help-modal-tag">{t("workspace.ready.sqlEditor")}</span>
            <span className="app-help-modal-tag">{t("sidebar.explorer")}</span>
            <span className="app-help-modal-tag">{t("workspace.kicker.structure")}</span>
            <span className="app-help-modal-tag">{t("common.metrics")}</span>
          </div>
        </div>

        <div className="app-help-modal-section">
          <span className="app-help-modal-section-label">{t("help.about.engines")}</span>
          <div className="app-help-modal-tags">
            <span className="app-help-modal-tag">MySQL</span>
            <span className="app-help-modal-tag">PostgreSQL</span>
            <span className="app-help-modal-tag">SQLite</span>
          </div>
        </div>

        <div className="app-help-modal-split">
          <div className="app-help-modal-panel">
            <span className="app-help-modal-section-label">{t("help.about.runtime")}</span>
            <strong className="app-help-modal-panel-title">{t("help.about.runtimeValue")}</strong>
            <p className="app-help-modal-panel-description">{t("help.about.runtimeDescription")}</p>
          </div>
          <div className="app-help-modal-panel">
            <span className="app-help-modal-section-label">{t("help.about.safety")}</span>
            <strong className="app-help-modal-panel-title">{t("help.about.safetyValue")}</strong>
            <p className="app-help-modal-panel-description">{t("help.about.safetyDescription")}</p>
          </div>
        </div>

        <div className="app-help-modal-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onClose}
          >
            {t("common.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
