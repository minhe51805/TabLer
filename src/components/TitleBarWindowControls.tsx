import { Copy, Minus, Square, X } from "lucide-react";
import { useI18n } from "../i18n";

interface TitleBarWindowControlsProps {
  isWindowMaximized: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

export function TitleBarWindowControls({
  isWindowMaximized,
  onMinimize,
  onToggleMaximize,
  onClose,
}: TitleBarWindowControlsProps) {
  const { t } = useI18n();

  return (
    <div className="titlebar-window-controls startup-window-controls" data-no-window-drag="true">
      <button
        type="button"
        onClick={onMinimize}
        className="titlebar-window-btn"
        title={t("titlebar.minimize")}
        aria-label={t("titlebar.minimize")}
      >
        <Minus className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={onToggleMaximize}
        className="titlebar-window-btn"
        title={isWindowMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
        aria-label={isWindowMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
      >
        {isWindowMaximized ? (
          <Copy className="w-3.5 h-3.5" />
        ) : (
          <Square className="w-3.5 h-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={onClose}
        className="titlebar-window-btn danger"
        title={t("titlebar.close")}
        aria-label={t("titlebar.close")}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}