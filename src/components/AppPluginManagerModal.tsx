import { Puzzle, Database, Box, Download, X } from "lucide-react";
import { useMemo } from "react";
import { useI18n } from "../i18n";
import { ALL_DATABASES } from "./ConnectionForm/engine-registry";

interface AppPluginManagerModalProps {
  onClose: () => void;
}

const CORE_MODULES = [
  "Explorer",
  "SQL Editor",
  "Metrics",
  "ER Diagram",
  "Terminal",
  "AI Assist",
];

export function AppPluginManagerModal({ onClose }: AppPluginManagerModalProps) {
  const { language } = useI18n();

  const copy = useMemo(() => {
    if (language === "vi") {
      return {
        kicker: "Plugins",
        title: "Quản lý plugin",
        description:
          "Theo dõi trạng thái các module lõi và adapter cơ sở dữ liệu đang được đóng gói trong build hiện tại.",
        bundled: "Tích hợp sẵn",
        adapterCount: "Adapter DB",
        coreModules: "Module lõi",
        engineAdapters: "Adapter cơ sở dữ liệu",
        planned: "Lộ trình plugin ngoài",
        builtin: "Built-in",
        ready: "Sẵn sàng",
        roadmap: "Lộ trình",
        note:
          "Bước tiếp theo có thể tách các adapter DB thành plugin tải theo nhu cầu mà không đổi workflow phía người dùng.",
        close: "Đóng",
      };
    }

    return {
      kicker: "Plugins",
      title: "Plugin Manager",
      description:
        "Review the core modules and database adapters currently bundled into this build.",
      bundled: "Bundled",
      adapterCount: "DB adapters",
      coreModules: "Core modules",
      engineAdapters: "Database adapters",
      planned: "External plugin roadmap",
      builtin: "Built-in",
      ready: "Ready",
      roadmap: "Roadmap",
      note:
        "The next step can split database adapters into on-demand plugins without changing the user workflow.",
      close: "Close",
    };
  }, [language]);

  const readyAdapters = ALL_DATABASES.filter((db) => db.supported);
  const roadmapAdapters = ALL_DATABASES.filter((db) => !db.supported);

  return (
    <div className="app-help-modal-backdrop" onClick={onClose}>
      <div className="app-help-modal app-plugin-manager-modal" onClick={(event) => event.stopPropagation()}>
        <div className="app-help-modal-header">
          <div className="app-help-modal-copy">
            <span className="app-help-modal-kicker">{copy.kicker}</span>
            <h3 className="app-help-modal-title">{copy.title}</h3>
            <p className="app-help-modal-description">{copy.description}</p>
          </div>
          <button
            type="button"
            className="app-help-modal-close"
            onClick={onClose}
            aria-label={copy.close}
          >
            <X size={16} />
          </button>
        </div>

        <div className="app-help-modal-grid">
          <div className="app-help-modal-metric">
            <span className="app-help-modal-metric-label">{copy.bundled}</span>
            <strong className="app-help-modal-metric-value">{CORE_MODULES.length}</strong>
          </div>
          <div className="app-help-modal-metric">
            <span className="app-help-modal-metric-label">{copy.adapterCount}</span>
            <strong className="app-help-modal-metric-value">{readyAdapters.length}</strong>
          </div>
        </div>

        <div className="app-plugin-manager-section">
          <div className="app-plugin-manager-section-head">
            <span className="app-help-modal-section-label">{copy.coreModules}</span>
            <span className="app-plugin-manager-badge">
              <Box className="w-3.5 h-3.5" />
              {copy.builtin}
            </span>
          </div>
          <div className="app-help-modal-tags">
            {CORE_MODULES.map((moduleName) => (
              <span key={moduleName} className="app-help-modal-tag">
                {moduleName}
              </span>
            ))}
          </div>
        </div>

        <div className="app-plugin-manager-section">
          <div className="app-plugin-manager-section-head">
            <span className="app-help-modal-section-label">{copy.engineAdapters}</span>
            <span className="app-plugin-manager-badge accent">
              <Database className="w-3.5 h-3.5" />
              {readyAdapters.length} {copy.ready}
            </span>
          </div>
          <div className="app-plugin-manager-list">
            {readyAdapters.map((db) => (
              <div key={db.key} className="app-plugin-manager-row">
                <span className="app-plugin-manager-row-title">{db.label}</span>
                <span className="app-plugin-manager-row-state ready">{copy.ready}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="app-plugin-manager-section">
          <div className="app-plugin-manager-section-head">
            <span className="app-help-modal-section-label">{copy.planned}</span>
            <span className="app-plugin-manager-badge muted">
              <Download className="w-3.5 h-3.5" />
              {roadmapAdapters.length} {copy.roadmap}
            </span>
          </div>
          <div className="app-plugin-manager-list compact">
            {roadmapAdapters.length === 0 ? (
              <div className="app-plugin-manager-row">
                <span className="app-plugin-manager-row-title">{copy.ready}</span>
                <span className="app-plugin-manager-row-state ready">{copy.builtin}</span>
              </div>
            ) : (
              roadmapAdapters.map((db) => (
                <div key={db.key} className="app-plugin-manager-row">
                  <span className="app-plugin-manager-row-title">{db.label}</span>
                  <span className="app-plugin-manager-row-state roadmap">{copy.roadmap}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="app-plugin-manager-note">
          <Puzzle className="w-4 h-4" />
          <span>{copy.note}</span>
        </div>

        <div className="app-help-modal-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onClose}
          >
            {copy.close}
          </button>
        </div>
      </div>
    </div>
  );
}
