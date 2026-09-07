import { X, Shield, Zap, Globe, Code2, FileWarning } from "lucide-react";
import { useI18n } from "../i18n";
import { UpdateButton } from "./UpdateButton";
import { APP_VERSION } from "../constants/version";

interface AppAboutModalProps {
  onClose: () => void;
  onOpenDiagnostics?: () => void;
}

export function AppAboutModal({ onClose, onOpenDiagnostics }: AppAboutModalProps) {
  const { t } = useI18n();

  return (
    <div className="app-help-modal-backdrop" onClick={onClose}>
      <div className="app-help-modal" onClick={(event) => event.stopPropagation()}>
        {/* Ambient glow */}
        <div className="app-help-modal-glow" />

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
            <strong className="app-help-modal-metric-value">{APP_VERSION}</strong>
          </div>
          <div className="app-help-modal-metric">
            <span className="app-help-modal-metric-label">{t("help.about.build")}</span>
            <strong className="app-help-modal-metric-value">Desktop</strong>
          </div>
          <div className="app-help-modal-metric">
            <span className="app-help-modal-metric-label">Runtime</span>
            <strong className="app-help-modal-metric-value">Tauri + React</strong>
          </div>
        </div>

        <div className="app-help-modal-features compact">
          <div className="app-help-modal-feature">
            <Shield className="w-4 h-4 text-[var(--fintech-green)]" />
            <span>Secure Storage</span>
          </div>
          <div className="app-help-modal-feature">
            <Zap className="w-4 h-4 text-[var(--fintech-green)]" />
            <span>Lightning Fast</span>
          </div>
          <div className="app-help-modal-feature">
            <Globe className="w-4 h-4 text-[var(--fintech-green)]" />
            <span>Cross Platform</span>
          </div>
          <div className="app-help-modal-feature">
            <Code2 className="w-4 h-4 text-[var(--fintech-green)]" />
            <span>AI Powered</span>
          </div>
        </div>

        <div className="app-help-modal-section compact">
          <span className="app-help-modal-section-label">{t("help.about.modules")}</span>
          <div className="app-help-modal-tags">
            <span className="app-help-modal-tag">{t("workspace.ready.sqlEditor")}</span>
            <span className="app-help-modal-tag">{t("sidebar.explorer")}</span>
            <span className="app-help-modal-tag">{t("workspace.kicker.structure")}</span>
            <span className="app-help-modal-tag">{t("common.metrics")}</span>
            <span className="app-help-modal-tag">ERD</span>
          </div>
        </div>

        <div className="app-help-modal-section compact">
          <span className="app-help-modal-section-label">{t("help.about.engines")}</span>
          <div className="app-help-modal-tags">
            <span className="app-help-modal-tag">MySQL</span>
            <span className="app-help-modal-tag">PostgreSQL</span>
            <span className="app-help-modal-tag">SQLite</span>
            <span className="app-help-modal-tag">MSSQL</span>
            <span className="app-help-modal-tag">ClickHouse</span>
          </div>
        </div>

        <div className="app-help-modal-actions">
          <UpdateButton variant="ghost" size="md" className="app-help-modal-update-btn" />
          {onOpenDiagnostics && (
            <button type="button" className="btn btn-secondary" onClick={onOpenDiagnostics}>
              <FileWarning size={15} />
              Export diagnostics
            </button>
          )}
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
