import { X, RotateCcw, AlertCircle } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { useI18n } from "../i18n";
import {
  getAllShortcuts,
  rebindShortcut,
  resetShortcut,
  resetAllShortcuts,
  type ShortcutBinding,
  type ShortcutAction,
} from "../stores/keyboard-shortcuts-store";

interface AppShortcutsModalProps {
  onClose: () => void;
}

type Category = "general" | "navigation" | "query" | "editing";

const CATEGORY_ORDER: Category[] = ["general", "navigation", "query", "editing"];
const CATEGORY_LABELS: Record<Category, string> = {
  general: "General",
  navigation: "Navigation",
  query: "Query",
  editing: "Editing",
};

function ShortcutRow({
  shortcut,
  isRecording,
  onStartRecord,
  onStopRecord,
  onReset,
  language,
}: {
  shortcut: ShortcutBinding;
  isRecording: boolean;
  onStartRecord: () => void;
  onStopRecord: () => void;
  onReset: () => void;
  language: string;
}) {
  return (
    <div className={`shortcuts-row ${isRecording ? "recording" : ""}`}>
      <span className="shortcuts-label">{shortcut.label}</span>
      <div className="shortcuts-actions">
        <button
          type="button"
          className={`shortcuts-key-btn ${isRecording ? "recording" : ""}`}
          onClick={isRecording ? onStopRecord : onStartRecord}
          title={
            isRecording
              ? language === "vi"
                ? "Nhấn phím mới..."
                : "Type new shortcut..."
              : language === "vi"
                ? "Nhấn để đổi phím tắt"
                : "Click to rebind"
          }
        >
          {isRecording ? (
            <span className="shortcuts-key-recording">
              {language === "vi" ? "Nhấn phím..." : "Press keys..."}
            </span>
          ) : (
            <kbd className="kbd">{shortcut.currentKey}</kbd>
          )}
        </button>
        {shortcut.currentKey !== shortcut.defaultKey && (
          <button
            type="button"
            className="shortcuts-reset-btn"
            onClick={onReset}
            title={language === "vi" ? "Khôi phục mặc định" : "Reset to default"}
          >
            <RotateCcw size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

export function AppShortcutsModal({ onClose }: AppShortcutsModalProps) {
  const { t, language } = useI18n();
  const [shortcuts, setShortcuts] = useState<ShortcutBinding[]>(() => getAllShortcuts());
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [conflict, setConflict] = useState<{ action: ShortcutAction; label: string } | null>(null);
  const [showResetAll, setShowResetAll] = useState(false);
  const [recordingCombo, setRecordingCombo] = useState<string | null>(null);

  useEffect(() => {
    setShortcuts(getAllShortcuts());
  }, []);

  useEffect(() => {
    if (!recording) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (e.metaKey) parts.push("Cmd");

      const key = e.key;
      if (
        key !== "Control" &&
        key !== "Alt" &&
        key !== "Shift" &&
        key !== "Meta" &&
        key !== "Dead" &&
        key !== "CapsLock"
      ) {
        parts.push(key.length === 1 ? key.toUpperCase() : key);
      }

      if (parts.length === 0) return;

      const combo = parts.join("+");
      setRecordingCombo(combo);
      setConflict(null);

      const result = rebindShortcut(recording, combo);
      if (result.success) {
        setShortcuts(getAllShortcuts());
        setRecording(null);
        setConflict(null);
        setRecordingCombo(null);
      } else if (result.conflict) {
        setConflict(result.conflict);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setRecording(null);
        setConflict(null);
        setRecordingCombo(null);
      }
    };

    document.addEventListener("keydown", handleKeyDown, { capture: true });
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
      document.removeEventListener("keydown", handleEscape);
    };
  }, [recording]);

  const handleReset = useCallback((action: ShortcutAction) => {
    resetShortcut(action);
    setShortcuts(getAllShortcuts());
  }, []);

  const handleResetAll = useCallback(() => {
    resetAllShortcuts();
    setShortcuts(getAllShortcuts());
    setShowResetAll(false);
  }, []);

  const handleConflictOverride = useCallback(() => {
    if (!recording || !recordingCombo) return;
    resetShortcut(conflict!.action);
    const result = rebindShortcut(recording, recordingCombo, conflict!.action);
    if (result.success) {
      setShortcuts(getAllShortcuts());
      setRecording(null);
      setConflict(null);
      setRecordingCombo(null);
    }
  }, [recording, recordingCombo, conflict]);

  const grouped: Record<Category, ShortcutBinding[]> = {
    general: shortcuts.filter((s) => s.category === "general"),
    navigation: shortcuts.filter((s) => s.category === "navigation"),
    query: shortcuts.filter((s) => s.category === "query"),
    editing: shortcuts.filter((s) => s.category === "editing"),
  };

  const vi = language === "vi";

  return (
    <div className="app-help-modal-backdrop" onClick={onClose}>
      <div
        className="app-help-modal app-help-modal-shortcuts shortcuts-modal-large"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="app-help-modal-header">
          <div className="app-help-modal-copy">
            <span className="app-help-modal-kicker">{t("help.shortcuts.kicker")}</span>
            <h3 className="app-help-modal-title">{t("help.shortcuts.title")}</h3>
            <p className="app-help-modal-description">
              {vi
                ? "Nhấn vào phím tắt để thay đổi. Nhấn Escape để hủy."
                : "Click a shortcut to rebind. Press Escape to cancel recording."}
            </p>
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

        <div className="shortcuts-grid">
          {CATEGORY_ORDER.map((cat) => {
            const items = grouped[cat];
            if (items.length === 0) return null;
            return (
              <div key={cat} className="shortcuts-category">
                <h4 className="shortcuts-category-title">{CATEGORY_LABELS[cat]}</h4>
                <div className="shortcuts-list">
                  {items.map((s) => (
                    <ShortcutRow
                      key={s.action}
                      shortcut={s}
                      isRecording={recording === s.action}
                      onStartRecord={() => {
                        setRecording(s.action);
                        setConflict(null);
                        setRecordingCombo(null);
                      }}
                      onStopRecord={() => {
                        setRecording(null);
                        setConflict(null);
                        setRecordingCombo(null);
                      }}
                      onReset={() => handleReset(s.action)}
                      language={language}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {conflict ? (
          <div className="shortcuts-conflict">
            <AlertCircle size={14} />
            <span>
              {vi
                ? `Phím này đã được gán cho "${conflict.label}". Muốn ghi đè?`
                : `Already assigned to "${conflict.label}". Override?`}{" "}
              <button type="button" className="shortcuts-conflict-override" onClick={handleConflictOverride}>
                {vi ? "Ghi đè" : "Override"}
              </button>
            </span>
          </div>
        ) : null}

        <div className="app-help-modal-footer">
          {!showResetAll ? (
            <button
              type="button"
              className="shortcuts-reset-all-btn"
              onClick={() => setShowResetAll(true)}
            >
              {vi ? "Đặt lại tất cả" : "Reset all shortcuts"}
            </button>
          ) : (
            <div className="shortcuts-reset-all-confirm">
              <span>{vi ? "Bạn chắc chứ?" : "Are you sure?"}</span>
              <button type="button" className="btn btn-danger" onClick={handleResetAll}>
                {vi ? "Đặt lại tất cả" : "Reset all"}
              </button>
              <button type="button" className="btn" onClick={() => setShowResetAll(false)}>
                {vi ? "Hủy" : "Cancel"}
              </button>
            </div>
          )}
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t("common.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
