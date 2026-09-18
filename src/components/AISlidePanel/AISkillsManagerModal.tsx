import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { invokeMutation } from "../../utils/tauri-utils";
import { useSkillUsageStore } from "../../stores/skillUsageStore";
import { useSkillPrefsStore } from "../../stores/skillPrefsStore";
import { buildSkillHealthReport, type SkillCatalogEntry } from "./ai-skill-health";

interface AISkillsManagerModalProps {
  open: boolean;
  language: string;
  onClose: () => void;
}

/** Mirrors `MAX_SKILL_DESCRIPTION_CHARS` / `MAX_SKILL_BODY_CHARS` in ai_skills.rs. */
const MAX_SKILL_DESCRIPTION_CHARS = 200;
const MAX_SKILL_BODY_CHARS = 8000;
/**
 * Marker `read_ai_skill` appends when a SKILL.md is past the editable body limit.
 * Seeing it means the body on screen is a prefix, so saving would truncate the
 * file — the editor goes read-only instead.
 */
const TRUNCATED_BODY_MARKER = "[body truncated at";
/** The only skills root the app writes to (mirrors `update_ai_skill`). */
const WRITABLE_SKILL_SOURCE = "global";

/** What `read_ai_skill` returns — the editor's prefill. */
interface AISkillContent {
  name: string;
  description: string;
  source: string;
  body: string;
  version: string | null;
  license: string | null;
  model: string | null;
  effort: string | null;
  allowedTools: string[];
}

/** The editor form's state, for both "create" and "edit". */
interface SkillDraft {
  mode: "create" | "edit";
  /** Directory name and frontmatter name — immutable once the skill exists. */
  name: string;
  description: string;
  version: string;
  body: string;
  /** Comma-separated in the field; split on save. */
  allowedTools: string;
  /** Metadata the manager does not interpret, round-tripped so a save keeps it. */
  license: string;
  model: string;
  effort: string;
  source: string;
}

/**
 * Agent Skills manager: the health view (usage + standing context cost),
 * per-skill enable/disable opt-out, and the SKILL.md editor — the local
 * equivalent of Claude Code's `/skill-doctor` plus skill authoring. Strings are
 * inlined per language to keep the component self-contained.
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
  /** Non-null while the editor is open; the panes are hidden behind it. */
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  /** Name whose SKILL.md is being fetched, so Edit can show a spinner. */
  const [draftLoading, setDraftLoading] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  /** Save/create failures stay inside the editor, not the roster behind it. */
  const [draftError, setDraftError] = useState<string | null>(null);

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

  /**
   * Only the global skills root is writable: a workspace skill is a file inside
   * the user's own repository, and the app must not rewrite project files it did
   * not author (mirrors what `update_ai_skill` can reach).
   */
  const canEditSelected = selectedRow?.source === WRITABLE_SKILL_SOURCE;

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
  const draftNameError = useMemo(() => {
    const name = draft?.name.trim() ?? "";
    if (!name) return null;
    if (name.length > 64 || !/^[A-Za-z0-9-]+$/.test(name)) {
      return t(
        "Tên skill chỉ gồm chữ, số và gạch ngang (1-64 ký tự).",
        "Skill name must be 1-64 characters of letters, digits, or dashes.",
      );
    }
    return null;
  }, [draft?.name, t]);

  /**
   * `read_ai_skill` truncates a huge body, so what the editor shows would not be
   * what a save wrote back. The file is then edited in place instead.
   */
  const draftBodyTruncated = draft?.body.includes(TRUNCATED_BODY_MARKER) ?? false;

  const updateDraft = useCallback((patch: Partial<SkillDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const openCreateDraft = useCallback(() => {
    setDraftError(null);
    setDraft({
      mode: "create",
      name: "",
      description: "",
      version: "0.1.0",
      body: "",
      allowedTools: "",
      license: "",
      model: "",
      effort: "",
      source: WRITABLE_SKILL_SOURCE,
    });
  }, []);

  /** Load one skill's SKILL.md into the editor. */
  const openEditDraft = useCallback(
    async (name: string) => {
      if (draftLoading) return;
      setDraftError(null);
      setDraftLoading(name);
      try {
        const content = await invokeMutation<AISkillContent>("read_ai_skill", { name });
        setDraft({
          mode: "edit",
          name: content.name,
          description: content.description ?? "",
          version: content.version ?? "",
          body: content.body ?? "",
          allowedTools: (content.allowedTools ?? []).join(", "),
          license: content.license ?? "",
          model: content.model ?? "",
          effort: content.effort ?? "",
          source: content.source,
        });
      } catch (err) {
        setError(String(err));
      } finally {
        setDraftLoading(null);
      }
    },
    [draftLoading],
  );

  /**
   * Save the editor: `create_ai_skill` for a new skill, `update_ai_skill` for an
   * existing one. Both paths re-read the catalog afterwards — the file on disk is
   * the source of truth, so the roster must not be guessed from local state.
   */
  const handleSaveDraft = useCallback(async () => {
    if (!draft || draftBusy || draftBodyTruncated) return;
    const name = draft.name.trim();
    if (!name || draftNameError) return;
    setDraftBusy(true);
    setDraftError(null);
    try {
      const description = draft.description.trim() || null;
      const body = draft.body.trim() || null;
      let path: string;
      if (draft.mode === "create") {
        path = await invokeMutation<string>("create_ai_skill", { name, description, body });
      } else {
        path = await invokeMutation<string>("update_ai_skill", {
          name,
          description,
          body,
          version: draft.version.trim() || null,
          // Tauri hands camelCase argument names to snake_case Rust parameters.
          allowedTools: draft.allowedTools
            .split(",")
            .map((tool) => tool.trim())
            .filter(Boolean),
          license: draft.license.trim() || null,
          model: draft.model.trim() || null,
          effort: draft.effort.trim() || null,
        });
      }
      setNotice(t(`Đã lưu skill tại: ${path}`, `Saved skill at: ${path}`));
      setDraft(null);
      setSelectedName(name);
      await refresh();
    } catch (err) {
      setDraftError(String(err));
    } finally {
      setDraftBusy(false);
    }
  }, [draft, draftBusy, draftBodyTruncated, draftNameError, refresh, t]);

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

          {draft ? (
            /* The SKILL.md editor. Same dialog, full width: the old one-line
               strip could not show a description, a body or a validation error,
               which is what made authoring painful. Escape leaves the editor,
               not the manager. */
            <form
              className="ai-skills-manager-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSaveDraft();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setDraft(null);
                }
              }}
            >
              <div className="ai-skills-manager-editor-head">
                <div className="ai-skills-manager-editor-copy">
                  <span className="ai-skills-manager-editor-title">
                    {draft.mode === "create"
                      ? t("Skill mới", "New skill")
                      : t(`Sửa ${draft.name}`, `Edit ${draft.name}`)}
                  </span>
                  <span className="ai-skills-manager-editor-sub">
                    {draft.mode === "create"
                      ? t(
                          "Ghi skills/<tên>/SKILL.md với frontmatter hợp lệ.",
                          "Writes skills/<name>/SKILL.md with valid frontmatter.",
                        )
                      : t(
                          `Nguồn: ${draft.source} — ghi đè SKILL.md của skill này.`,
                          `Source: ${draft.source} — overwrites this skill's SKILL.md.`,
                        )}
                  </span>
                </div>
                <div className="ai-skills-manager-editor-actions">
                  <button
                    type="button"
                    className="ai-skills-manager-btn is-ghost"
                    onClick={() => setDraft(null)}
                  >
                    {t("Huỷ", "Cancel")}
                  </button>
                  <button
                    type="submit"
                    className="ai-skills-manager-btn is-primary"
                    disabled={
                      !draft.name.trim() ||
                      draftNameError !== null ||
                      draftBusy ||
                      draftBodyTruncated
                    }
                  >
                    {draftBusy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Check className="w-3.5 h-3.5" />
                    )}
                    {draft.mode === "create"
                      ? t("Tạo skill", "Create skill")
                      : t("Lưu thay đổi", "Save changes")}
                  </button>
                </div>
              </div>

              <div className="ai-skills-manager-fields">
                <div className="ai-skills-manager-field-row">
                  <label className="ai-skills-manager-field">
                    <span className="ai-skills-manager-field-label">
                      {t("Tên skill", "Skill name")}
                    </span>
                    <input
                      type="text"
                      value={draft.name}
                      aria-label={t("Tên skill", "Skill name")}
                      // The name is also the directory, so an existing skill cannot
                      // be renamed from here — that would fork a second copy.
                      readOnly={draft.mode === "edit"}
                      autoFocus={draft.mode === "create"}
                      maxLength={64}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={t("ten-skill-cua-ban", "your-skill-name")}
                      aria-invalid={draftNameError !== null}
                      onChange={(event) => updateDraft({ name: event.target.value })}
                    />
                    <span
                      className={`ai-skills-manager-field-hint ${draftNameError ? "is-error" : ""}`}
                      role={draftNameError ? "alert" : undefined}
                    >
                      {draftNameError ??
                        (draft.mode === "edit"
                          ? t(
                              "Tên cũng là tên thư mục nên không đổi được.",
                              "The name is the folder name, so it cannot change.",
                            )
                          : t(
                              "Chữ, số và gạch ngang (1-64 ký tự). Tên này cũng là tên thư mục.",
                              "Letters, digits and dashes (1-64). This is also the folder name.",
                            ))}
                    </span>
                  </label>

                  <label className="ai-skills-manager-field">
                    <span className="ai-skills-manager-field-label">
                      {t("Phiên bản", "Version")}
                    </span>
                    <input
                      type="text"
                      value={draft.version}
                      aria-label={t("Phiên bản", "Version")}
                      maxLength={32}
                      spellCheck={false}
                      placeholder="0.1.0"
                      onChange={(event) => updateDraft({ version: event.target.value })}
                    />
                    <span className="ai-skills-manager-field-hint">
                      {t("Hiện trong danh sách.", "Shown in the roster.")}
                    </span>
                  </label>
                </div>

                <label className="ai-skills-manager-field is-wide">
                  <span className="ai-skills-manager-field-label">
                    {t("Mô tả", "Description")}
                    <span className="ai-skills-manager-field-count">
                      {draft.description.length}/{MAX_SKILL_DESCRIPTION_CHARS}
                    </span>
                  </span>
                  <input
                    type="text"
                    value={draft.description}
                    aria-label={t("Mô tả", "Description")}
                    maxLength={MAX_SKILL_DESCRIPTION_CHARS}
                    placeholder={t(
                      "Dùng khi người dùng hỏi về…",
                      "Use this when the user asks about…",
                    )}
                    onChange={(event) => updateDraft({ description: event.target.value })}
                  />
                  <span className="ai-skills-manager-field-hint">
                    {t(
                      "Đây là câu agent đọc để quyết định có dùng skill hay không — nên viết dạng “dùng khi…”.",
                      "This is the line the agent reads to decide whether to load the skill — phrase it as “use this when…”.",
                    )}
                  </span>
                </label>

                {/* The body is the procedure the agent follows — the one thing
                    the old form could not accept, which is why every skill was
                    created as an empty scaffold. */}
                <label className="ai-skills-manager-field is-wide is-grow">
                  <span className="ai-skills-manager-field-label">
                    {t("Nội dung SKILL.md", "SKILL.md body")}
                    <span className="ai-skills-manager-field-count">
                      {draft.body.length}/{MAX_SKILL_BODY_CHARS}
                    </span>
                  </span>
                  <textarea
                    value={draft.body}
                    aria-label={t("Nội dung SKILL.md", "SKILL.md body")}
                    readOnly={draftBodyTruncated}
                    maxLength={MAX_SKILL_BODY_CHARS}
                    spellCheck={false}
                    placeholder={t(
                      "# tên-skill\n\nDùng khi nào…\n\n## Các bước\n\n1. Bước đầu tiên.\n2. Bước tiếp theo.",
                      "# skill-name\n\nWhen this applies…\n\n## Steps\n\n1. First step.\n2. Next step.",
                    )}
                    onChange={(event) => updateDraft({ body: event.target.value })}
                  />
                  <span
                    className={`ai-skills-manager-field-hint ${
                      draftBodyTruncated ? "is-error" : ""
                    }`}
                    role={draftBodyTruncated ? "alert" : undefined}
                  >
                    {draftBodyTruncated
                      ? t(
                          "SKILL.md dài hơn giới hạn sửa được nên chỉ hiện phần đầu. Hãy sửa trực tiếp trong file để không mất phần còn lại.",
                          "SKILL.md is longer than the editable limit, so only the head is shown. Edit the file directly so the rest is not lost.",
                        )
                      : t(
                          "Đây là nội dung agent nạp khi skill được chọn. Để chi tiết dài (schema, ví dụ) vào references/ và đọc khi cần.",
                          "This is what the agent loads once the skill is picked. Keep long details (schemas, examples) in references/ and load them on demand.",
                        )}
                  </span>
                </label>

                <label className="ai-skills-manager-field is-wide">
                  <span className="ai-skills-manager-field-label">
                    {t("Công cụ được phép", "Allowed tools")}
                  </span>
                  <input
                    type="text"
                    value={draft.allowedTools}
                    aria-label={t("Công cụ được phép", "Allowed tools")}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="run_readonly_sql, describe_table"
                    onChange={(event) => updateDraft({ allowedTools: event.target.value })}
                  />
                  <span className="ai-skills-manager-field-hint">
                    {t(
                      "Tuỳ chọn, cách nhau bằng dấu phẩy. Để trống = không giới hạn công cụ.",
                      "Optional, comma separated. Empty = the skill restricts no tools.",
                    )}
                  </span>
                </label>

                {draftError ? (
                  <div className="ai-skills-manager-error" role="alert">
                    <TriangleAlert className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{draftError}</span>
                  </div>
                ) : null}
              </div>
            </form>
          ) : (
            <>
              <div className="ai-skills-manager-toolbar">
                <label className="ai-skills-manager-search">
                  <Search className="w-3.5 h-3.5" aria-hidden="true" />
                  <span className="sr-only">{t("Tìm skill", "Search skills")}</span>
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t(
                      "Tìm theo tên, mô tả, nguồn…",
                      "Search name, description, source…",
                    )}
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
                    className="ai-skills-manager-btn is-primary"
                    onClick={openCreateDraft}
                    title={t("Tạo skill mới", "Create a new skill")}
                  >
                    <Plus className="w-3.5 h-3.5" /> {t("Skill mới", "New skill")}
                  </button>
                  <button
                    type="button"
                    className="ai-skills-manager-btn is-icon"
                    onClick={() => void handleOpenFolder()}
                    title={t("Mở thư mục skills", "Open the skills folder")}
                    aria-label={t("Mở thư mục skills", "Open the skills folder")}
                  >
                    <FolderOpen className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    className="ai-skills-manager-btn is-icon"
                    onClick={() => void refresh()}
                    disabled={loading}
                    title={t("Làm mới danh sách", "Reload the list")}
                    aria-label={t("Làm mới danh sách", "Reload the list")}
                  >
                    {loading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

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
                          <span className="ai-skills-manager-row-version">
                            v{selectedRow.version}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className="ai-skills-manager-btn is-ghost is-small"
                          onClick={() => void openEditDraft(selectedRow.name)}
                          // Workspace skills are read-only here: they live in the
                          // user's repo, which this app never writes to.
                          disabled={!canEditSelected || draftLoading !== null}
                          title={
                            canEditSelected
                              ? t("Sửa skill này", "Edit this skill")
                              : t(
                                  "Skill thuộc workspace — sửa SKILL.md trong repo của bạn.",
                                  "Workspace skill — edit SKILL.md in your repository.",
                                )
                          }
                        >
                          {draftLoading === selectedRow.name ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Pencil className="w-3.5 h-3.5" />
                          )}
                          {t("Sửa", "Edit")}
                        </button>
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
                        <span className="ai-settings-section-label">
                          {t("Mô tả", "Description")}
                        </span>
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
                          {t("Dùng lần cuối", "Last used")}:{" "}
                          {formatLastUsed(selectedRow.lastUsedAt)}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
