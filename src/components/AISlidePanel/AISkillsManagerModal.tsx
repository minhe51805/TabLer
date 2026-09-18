import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderOpen, Loader2, Plus, RefreshCw, Search, TriangleAlert, X } from "lucide-react";
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
  /** Name filter — the manager is a long list of look-alike descriptions. */
  const [query, setQuery] = useState("");
  /** Name of the skill shown in the detail pane (master–detail selection). */
  const [selectedName, setSelectedName] = useState<string | null>(null);
  /** Inline scaffolder: open state, the name being typed, and its in-flight flag. */
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

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

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return report.rows;
    return report.rows.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) ||
        row.description.toLowerCase().includes(needle) ||
        row.source.toLowerCase().includes(needle),
    );
  }, [report.rows, query]);

  /**
   * Master–detail: the right pane always describes exactly one skill, so the
   * selection falls back to the first visible row — an empty pane next to a
   * full roster reads as a broken panel. Filtering re-derives the fallback, so
   * a search that hides the selected skill still shows a valid record.
   */
  const selectedRow = useMemo(
    () => visibleRows.find((row) => row.name === selectedName) ?? visibleRows[0] ?? null,
    [visibleRows, selectedName],
  );

  // Escape closes the dialog — the modal floats over the workspace panel with
  // no backdrop, so a keyboard exit is the only alternative to the X button.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const formatLastUsed = useCallback(
    (timestamp: number | null) =>
      timestamp === null
        ? t("chưa dùng lần nào", "never used")
        : new Date(timestamp).toLocaleString(isVi ? "vi-VN" : "en-US"),
    [isVi, t],
  );

  /**
   * Mirrors `validate_skill_name` in `src-tauri/src/ai_skills.rs` (1..=64 chars
   * of ASCII letters, digits or dashes) so a bad name is caught in the form
   * instead of costing a round-trip. `null` while the field is still empty —
   * "not typed yet" is not an error.
   */
  const nameError = useMemo(() => {
    const name = draftName.trim();
    if (!name) return null;
    if (name.length > 64 || !/^[A-Za-z0-9-]+$/.test(name)) {
      return t(
        "Tên skill chỉ gồm chữ, số và gạch ngang (1-64 ký tự).",
        "Skill name must be 1-64 characters of letters, digits, or dashes.",
      );
    }
    return null;
  }, [draftName, t]);

  const closeCreateForm = useCallback(() => {
    setCreating(false);
    setDraftName("");
  }, []);

  const handleCreate = useCallback(async () => {
    const name = draftName.trim();
    if (!name || nameError || createBusy) return;
    setCreateBusy(true);
    setError(null);
    try {
      const path = await invokeMutation<string>("create_ai_skill", {
        name,
        description: null,
        body: null,
      });
      setNotice(t(`Đã tạo skill tại: ${path}`, `Created skill at: ${path}`));
      closeCreateForm();
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setCreateBusy(false);
    }
  }, [closeCreateForm, createBusy, draftName, nameError, refresh, t]);

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
      <div
        className="ai-workspace-modal ai-skills-manager-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-skills-manager-title"
      >
        <div className="ai-workspace-modal-header">
          <div className="ai-workspace-modal-copy">
            <span className="ai-workspace-modal-kicker">Agent Skills</span>
            <h3 className="ai-workspace-modal-title" id="ai-skills-manager-title">
              {t("Quản lý Agent Skills", "Agent Skills")}
            </h3>
          </div>
          <button
            type="button"
            className="ai-workspace-modal-close"
            onClick={onClose}
            aria-label={t("Đóng", "Close")}
            title={t("Đóng", "Close")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="ai-skills-manager-body">
          <div className="ai-skills-manager-stats">
            <span className="ai-skills-manager-stat">
              <strong>
                {report.enabledSkills}/{report.totalSkills}
              </strong>
              {t("đang bật", "enabled")}
            </span>
            <span
              className={`ai-skills-manager-stat ${report.unusedEnabledSkills > 0 ? "is-warn" : ""}`}
            >
              <strong>{report.unusedEnabledSkills}</strong>
              {t("chưa dùng", "unused")}
            </span>
            <span className="ai-skills-manager-stat">
              <strong>
                ~{report.enabledCatalogCostChars.toLocaleString(isVi ? "vi-VN" : "en-US")}
              </strong>
              {t("ký tự mỗi lần chạy", "chars per run")}
            </span>
          </div>

          <div className="ai-skills-manager-toolbar">
            <label className="ai-skills-manager-search">
              <Search className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="sr-only">{t("Tìm skill", "Search skills")}</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("Tìm theo tên, mô tả, nguồn…", "Search name, description, source…")}
              />
              {query ? (
                <button
                  type="button"
                  className="ai-skills-manager-search-clear"
                  onClick={() => setQuery("")}
                  aria-label={t("Xoá tìm kiếm", "Clear search")}
                  title={t("Xoá tìm kiếm", "Clear search")}
                >
                  <X className="w-3 h-3" />
                </button>
              ) : null}
            </label>

            <div className="ai-skills-manager-actions">
              <button
                type="button"
                className={`toolbar-btn ${creating ? "primary" : ""}`}
                onClick={() => (creating ? closeCreateForm() : setCreating(true))}
                aria-expanded={creating}
                title={
                  creating
                    ? t("Đóng form tạo skill", "Close the create form")
                    : t("Tạo skill mới", "Create a new skill")
                }
              >
                <Plus className="w-3.5 h-3.5" /> {t("Skill mới", "New skill")}
              </button>
              <button
                type="button"
                className="toolbar-btn icon-only"
                onClick={() => void handleOpenFolder()}
                title={t("Mở thư mục skills", "Open the skills folder")}
                aria-label={t("Mở thư mục skills", "Open the skills folder")}
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                className="toolbar-btn icon-only"
                onClick={() => void refresh()}
                disabled={loading}
                title={t("Làm mới danh sách", "Reload the list")}
                aria-label={t("Làm mới danh sách", "Reload the list")}
              >
                {loading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>

          {/* Inline scaffolder. Was a native `window.prompt`, which left the
              design system entirely and could not validate the name, show the
              backend's own error, or keep a busy state while the write ran. */}
          {creating ? (
            <form
              className="ai-skills-manager-create"
              onSubmit={(event) => {
                event.preventDefault();
                void handleCreate();
              }}
            >
              <label className="ai-skills-manager-create-field">
                <span className="sr-only">{t("Tên skill", "Skill name")}</span>
                <input
                  type="text"
                  value={draftName}
                  autoFocus
                  maxLength={64}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={t("ten-skill-cua-ban", "your-skill-name")}
                  aria-invalid={nameError !== null}
                  onChange={(event) => setDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    // Escape closes the form, not the whole manager: stop the
                    // event before the window-level dialog listener sees it.
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      closeCreateForm();
                    }
                  }}
                />
              </label>
              <button
                type="submit"
                className="toolbar-btn primary"
                disabled={!draftName.trim() || nameError !== null || createBusy}
              >
                {createBusy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plus className="w-3.5 h-3.5" />
                )}
                {t("Tạo", "Create")}
              </button>
              <button type="button" className="toolbar-btn" onClick={closeCreateForm}>
                {t("Huỷ", "Cancel")}
              </button>
              <span
                className={`ai-skills-manager-create-hint ${nameError ? "is-error" : ""}`}
                role={nameError ? "alert" : undefined}
              >
                {nameError ??
                  t(
                    "Tạo thư mục skills/<tên>/SKILL.md với frontmatter hợp lệ.",
                    "Creates skills/<name>/SKILL.md with valid frontmatter.",
                  )}
              </span>
            </form>
          ) : null}

          {error ? (
            <div className="ai-skills-manager-error" role="alert">
              <TriangleAlert className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}
          {notice ? (
            <div className="ai-skills-manager-notice" role="status">
              <span>{notice}</span>
            </div>
          ) : null}

          {/* Master–detail, the Provider Settings shape: a roster column on the
              left, one skill's full record on the right. The old stack of cards
              repeated every description and turned an 11-skill catalog into a
              full-dialog scroll; the two panes now scroll independently. */}
          <div className="ai-settings-body">
            <aside className="ai-settings-sidebar">
              <div className="ai-settings-sidebar-group-label">
                {t("Danh sách", "Roster")}
                {visibleRows.length > 0 ? ` · ${visibleRows.length}` : ""}
              </div>
              {visibleRows.length === 0 ? (
                <div className="ai-skills-manager-empty">
                  {query.trim()
                    ? t(
                        `Không có skill nào khớp "${query.trim()}".`,
                        `No skill matches "${query.trim()}".`,
                      )
                    : loading
                      ? t("Đang tải…", "Loading…")
                      : t(
                          "Chưa có skill nào. Tạo skill mới để bắt đầu.",
                          "No skills yet. Create one to start.",
                        )}
                </div>
              ) : (
                <ul className="ai-settings-sidebar-list ai-skills-manager-list">
                  {visibleRows.map((row) => {
                    const isActive = selectedRow?.name === row.name;
                    return (
                      <li key={row.name}>
                        <button
                          type="button"
                          className={`ai-settings-sidebar-item ai-skills-manager-row ${
                            isActive ? "active" : ""
                          }`}
                          aria-pressed={isActive}
                          onClick={() => setSelectedName(row.name)}
                          title={row.description}
                        >
                          <span className="ai-settings-sidebar-item-icon" aria-hidden="true">
                            {row.name.charAt(0).toUpperCase()}
                          </span>
                          <span className="ai-settings-sidebar-item-name">{row.name}</span>
                          {/* Status lives in the dot, the way the provider roster
                              does it: green = injected every run, amber = enabled
                              but never used (the prune candidate), grey = off. */}
                          <span
                            className={`ai-provider-dot ${
                              !row.enabled ? "is-off" : row.unused ? "is-idle" : "is-on"
                            }`}
                            aria-hidden="true"
                          />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </aside>
            <section className="ai-settings-detail ai-skills-manager-detail-pane">
              {selectedRow ? (
                <>
                  <div className="ai-skills-manager-detail-head">
                    <span className="ai-skills-manager-detail-name">{selectedRow.name}</span>
                    {selectedRow.version ? (
                      <span className="ai-skills-manager-row-version">v{selectedRow.version}</span>
                    ) : null}
                    <button
                      type="button"
                      role="switch"
                      aria-checked={selectedRow.enabled}
                      aria-label={t(
                        `Bật skill ${selectedRow.name}`,
                        `Enable skill ${selectedRow.name}`,
                      )}
                      title={
                        selectedRow.enabled
                          ? t("Đang bật — bấm để tắt", "Enabled — click to disable")
                          : t("Đang tắt — bấm để bật", "Disabled — click to enable")
                      }
                      className={`ai-skills-manager-switch ${selectedRow.enabled ? "is-on" : ""}`}
                      onClick={() => setEnabled(selectedRow.name, !selectedRow.enabled)}
                    >
                      <span className="ai-skills-manager-knob" />
                    </button>
                  </div>

                  <div className="ai-skills-manager-detail-block">
                    <span className="ai-settings-section-label">{t("Mô tả", "Description")}</span>
                    <p className="ai-skills-manager-detail-text">{selectedRow.description}</p>
                  </div>

                  <div className="ai-skills-manager-detail-block">
                    <span className="ai-settings-section-label">{t("Sử dụng", "Usage")}</span>
                    <span className="ai-skills-manager-row-tags">
                      <span className="ai-skills-manager-tag">{selectedRow.source}</span>
                      <span className="ai-skills-manager-tag">
                        {t(`${selectedRow.runs} lần chạy`, `${selectedRow.runs} runs`)}
                      </span>
                      {selectedRow.unused ? (
                        <span className="ai-skills-manager-tag is-warn">
                          {t("chưa dùng", "unused")}
                        </span>
                      ) : null}
                      {selectedRow.enabled ? (
                        <span className="ai-skills-manager-tag">
                          ~{selectedRow.catalogCostChars} {t("ký tự", "chars")}
                        </span>
                      ) : (
                        <span className="ai-skills-manager-tag">
                          {t("không tính chi phí", "no context cost")}
                        </span>
                      )}
                    </span>
                    <span className="ai-skills-manager-detail-meta">
                      {t("Nguồn", "Source")}: {selectedRow.source}
                      {" · "}
                      {t("Dùng lần cuối", "Last used")}: {formatLastUsed(selectedRow.lastUsedAt)}
                      {" · "}
                      {t("Chi phí ngữ cảnh", "Context cost")}:{" "}
                      {selectedRow.enabled
                        ? `~${selectedRow.catalogCostChars} ${t("ký tự mỗi lần chạy", "chars/run")}`
                        : t("không tính (đang tắt)", "not counted (off)")}
                    </span>
                  </div>
                </>
              ) : query.trim() ? (
                <span className="ai-skills-manager-detail-meta">
                  {t("Không có skill nào được chọn.", "No skill selected.")}
                </span>
              ) : null}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
