import { X, Shield, Zap, Globe, Code2 } from "lucide-react";
import { useI18n } from "../i18n";
import { UpdateButton } from "./UpdateButton";

interface AppAboutModalProps {
  onClose: () => void;
}

export function AppAboutModal({ onClose }: AppAboutModalProps) {
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
            <strong className="app-help-modal-metric-value">0.1.1</strong>
          </div>
          <div className="app-help-modal-metric">
            <span className="app-help-modal-metric-label">{t("help.about.build")}</span>
            <strong className="app-help-modal-metric-value">Desktop</strong>
          </div>
        </div>

        {/* Feature Icons Row */}
        <div className="app-help-modal-features">
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
            <span className="app-help-modal-tag">MSSQL</span>
            <span className="app-help-modal-tag">ClickHouse</span>
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

        {/* Mini chart */}
        <div className="app-help-modal-chart">
          <svg viewBox="0 0 200 40" fill="none" xmlns="http://www.w3.org/2000/svg" className="app-help-modal-chart-svg">
            <defs>
              <linearGradient id="aboutChartGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--fintech-green)" stopOpacity="0.4" />
                <stop offset="100%" stopColor="var(--fintech-cyan)" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="aboutLineGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="var(--fintech-green)" />
                <stop offset="100%" stopColor="var(--fintech-cyan)" />
              </linearGradient>
            </defs>
            <path
              d="M0 32 L25 28 L50 30 L75 22 L100 25 L125 15 L150 18 L175 10 L200 8"
              stroke="url(#aboutLineGrad)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            <path
              d="M0 32 L25 28 L50 30 L75 22 L100 25 L125 15 L150 18 L175 10 L200 8 L200 40 L0 40 Z"
              fill="url(#aboutChartGrad)"
            />
          </svg>
        </div>

        <div className="app-help-modal-actions">
          <UpdateButton variant="secondary" size="md" />
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
