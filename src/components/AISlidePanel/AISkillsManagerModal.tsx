import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderOpen, Plus, RefreshCw, X } from "lucide-react";
import { invokeMutation } from "../../utils/tauri-utils";
import { useSkillUsageStore } from "../../stores/skillUsageStore";
import { useSkillPrefsStore } from "../../stores/skillPrefsStore";
import { buildSkillHealthReport, type SkillCatalogEntry } from "./ai-skill-health";

interface AISkillsManagerModalProps {
  open: boolean;
  language: string;
  onClose: () => void;
}

/**
 * Agent Skills manager: the health view (usage + standing context cost),
 * per-skill enable/disable opt-out, and a scaffolder — the local equivalent of
 * Claude Code's `/skill-doctor` plus skill authoring. Strings are inlined per
 * language to keep the component self-contained.
 */
export function AISkillsManagerModal({ open, language, onClose }: AISkillsManagerModalProps) {
  const isVi = language === "vi";
  const t = useCallback((vi: string, en: string) => (isVi ? vi : en), [isVi]);

  const usage = useSkillUsageStore((state) => state.usage);
  const disabled = useSkillPrefsStore((state) => state.disabled);
  const setEnabled = useSkillPrefsStore((state) => state.setEnabled);

  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entries = await invokeMutation<SkillCatalogEntry[]>("list_ai_skills", {});
      setCatalog(Array.isArray(entries) ? entries : []);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setNotice(null);
      void refresh();
    }
  }, [open, refresh]);

  const report = useMemo(
    () => buildSkillHealthReport(catalog, usage, (name) => disabled[name] !== true),
    [catalog, usage, disabled],
  );

  const handleCreate = useCallback(async () => {
    const name = window
      .prompt(t("Tên skill (chữ, số, gạch ngang):", "Skill name (letters, digits, dashes):"))
      ?.trim();
    if (!name) return;
    try {
      const path = await invokeMutation<string>("create_ai_skill", { name, description: null });
      setNotice(t(`Đã tạo skill tại: ${path}`, `Created skill at: ${path}`));
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }, [refresh, t]);

  const handleOpenFolder = useCallback(async () => {
    try {
      const path = await invokeMutation<string>("ai_skills_directory", {});
      setNotice(t(`Thư mục skills: ${path}`, `Skills folder: ${path}`));
    } catch (err) {
      setError(String(err));
    }
  }, [t]);

  if (!open) return null;

  return (
    <div className="ai-workspace-modal-layer">
      <div className="ai-workspace-modal" role="dialog" aria-modal="true">
        <div className="ai-workspace-modal-header">
          <h3 className="ai-workspace-modal-title">{t("Quản lý Agent Skills", "Agent Skills")}</h3>
          <button type="button" className="ai-workspace-modal-close" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="ai-skills-manager-body">
          <div className="ai-skills-manager-actions">
            <button type="button" className="toolbar-btn" onClick={() => void handleCreate()}>
              <Plus className="w-3.5 h-3.5" /> {t("Skill mới", "New skill")}
            </button>
            <button type="button" className="toolbar-btn" onClick={() => void handleOpenFolder()}>
              <FolderOpen className="w-3.5 h-3.5" /> {t("Thư mục", "Folder")}
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => void refresh()}
              disabled={loading}
            >
              <RefreshCw className="w-3.5 h-3.5" /> {t("Làm mới", "Refresh")}
            </button>
          </div>

          <div className="ai-skills-manager-summary">
            {t(
              `${report.enabledSkills}/${report.totalSkills} skill đang bật · ${report.unusedEnabledSkills} chưa dùng · ~${report.enabledCatalogCostChars} ký tự mỗi lần chạy`,
              `${report.enabledSkills}/${report.totalSkills} enabled · ${report.unusedEnabledSkills} unused · ~${report.enabledCatalogCostChars} chars/run`,
            )}
          </div>

          {error ? <div className="ai-skills-manager-error">{error}</div> : null}
          {notice ? <div className="ai-skills-manager-notice">{notice}</div> : null}

          {report.rows.length === 0 ? (
            <div className="ai-skills-manager-empty">
              {loading
                ? t("Đang tải…", "Loading…")
                : t(
                    "Chưa có skill nào. Tạo skill mới để bắt đầu.",
                    "No skills yet. Create one to start.",
                  )}
            </div>
          ) : (
            <ul className="ai-skills-manager-list">
              {report.rows.map((row) => (
                <li
                  key={row.name}
                  className={`ai-skills-manager-row ${row.enabled ? "" : "is-disabled"}`}
                >
                  <div className="ai-skills-manager-row-main">
                    <span className="ai-skills-manager-row-name">
                      {row.name}
                      {row.version ? (
                        <span className="ai-skills-manager-row-version"> v{row.version}</span>
                      ) : null}
                    </span>
                    <span className="ai-skills-manager-row-desc">{row.description}</span>
                    <span className="ai-skills-manager-row-meta">
                      {row.source}
                      {" · "}
                      {t(`${row.runs} lần chạy`, `${row.runs} runs`)}
                      {row.unused ? ` · ${t("chưa dùng", "unused")}` : ""}
                      {row.enabled ? ` · ~${row.catalogCostChars} ${t("ký tự", "chars")}` : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={`toolbar-btn icon-only ${row.enabled ? "is-active" : ""}`}
                    onClick={() => setEnabled(row.name, !row.enabled)}
                    title={row.enabled ? t("Tắt skill", "Disable skill") : t("Bật skill", "Enable skill")}
                  >
                    {row.enabled ? t("Bật", "On") : t("Tắt", "Off")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

