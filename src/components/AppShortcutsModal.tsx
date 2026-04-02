import { X } from "lucide-react";
import { useI18n } from "../i18n";

interface AppShortcutsModalProps {
  onClose: () => void;
}

export function AppShortcutsModal({ onClose }: AppShortcutsModalProps) {
  const { t, language } = useI18n();
  const toggleTerminalLabel = language === "vi" ? "Bat/tat terminal" : "Toggle terminal";

  const shortcuts = [
    { label: t("help.shortcuts.newQuery"), shortcut: "Ctrl+N" },
    { label: t("help.shortcuts.toggleSidebar"), shortcut: "Ctrl+B" },
    { label: t("help.shortcuts.openAi"), shortcut: "Ctrl+Shift+P / Ctrl+P" },
    { label: toggleTerminalLabel, shortcut: "Ctrl+`" },
    { label: t("help.shortcuts.runQuery"), shortcut: "Ctrl+Enter" },
    { label: t("help.shortcuts.increaseFont"), shortcut: "Ctrl++" },
    { label: t("help.shortcuts.decreaseFont"), shortcut: "Ctrl+-" },
    { label: t("help.shortcuts.toggleResults"), shortcut: "Ctrl+Shift+`" },
    { label: t("help.shortcuts.toggleRightSidebar"), shortcut: "Ctrl+Space" },
  ];

  return (
    <div className="app-help-modal-backdrop" onClick={onClose}>
      <div className="app-help-modal app-help-modal-shortcuts" onClick={(event) => event.stopPropagation()}>
        <div className="app-help-modal-header">
          <div className="app-help-modal-copy">
            <span className="app-help-modal-kicker">{t("help.shortcuts.kicker")}</span>
            <h3 className="app-help-modal-title">{t("help.shortcuts.title")}</h3>
            <p className="app-help-modal-description">{t("help.shortcuts.description")}</p>
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

        <div className="app-shortcuts-list">
          {shortcuts.map((item) => (
            <div key={item.label} className="app-shortcuts-row">
              <span className="app-shortcuts-label">{item.label}</span>
              <kbd className="kbd">{item.shortcut}</kbd>
            </div>
          ))}
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
