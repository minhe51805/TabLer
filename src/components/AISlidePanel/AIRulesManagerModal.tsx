import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Plus, RefreshCw, TriangleAlert, X } from "lucide-react";
import { invokeMutation } from "../../utils/tauri-utils";
import { getLinkedWorkspaceDir } from "../../hooks/useLinkedFolders";
import { useI18n } from "../../i18n";
import { formatPanelCopy, getAIPanelCopy } from "./ai-panel-copy";
import type { AgentRuleEvaluation, AgentRuleMatch } from "./ai-agent-rules";

interface AIRulesManagerModalProps {
  open: boolean;
  onClose: () => void;
}

/** Mirrors `MAX_RULE_NAME_CHARS` in agent_rules.rs (slug, 1-64 chars). */
const RULE_NAME_PATTERN = /^[a-z0-9_-]{1,64}$/;

/** Starter file the New-rule form prefills — the shape the engine parses. */
const RULE_TEMPLATE = `---
name: {name}
description: What this rule guards and why.
enabled: true
event: pre_write
pattern: (?is)\\bdrop\\s+table\\b
action: block
---

# {name}

Explain the rule for the next person who reads this file.
`;

/**
 * Guardrail rules manager: the armed pack (`list_agent_rules`) plus the files
 * that failed to load, and a "New rule" form that writes a validated .md into
 * `<linked-folder>/rules` via `write_workspace_rule` — the same directory
 * `evaluate_agent_rules` scans first for the workspace.
 */
export function AIRulesManagerModal({ open, onClose }: AIRulesManagerModalProps) {
  const { language } = useI18n();
  const copy = getAIPanelCopy(language).rules;

  const [rules, setRules] = useState<AgentRuleMatch[]>([]);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** First linked folder — the workspace rules root; null disables authoring. */
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  /** Non-null while the New-rule form is open. */
  const [draft, setDraft] = useState<{ name: string; content: string } | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const refresh = useCallback(async (dir: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const evaluation = await invokeMutation<AgentRuleEvaluation>("list_agent_rules", {
        workspaceDir: dir,
      });
      setRules(evaluation.verdict.matched_rules);
      setLoadErrors(evaluation.report.errors.map((entry) => `${entry.path}: ${entry.reason}`));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setNotice(null);
    setDraft(null);
    void getLinkedWorkspaceDir().then((dir) => {
      setWorkspaceDir(dir);
      void refresh(dir);
    });
  }, [open, refresh]);

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

  const originLabel = useCallback(
    (origin: AgentRuleMatch["origin"]) =>
      origin === "builtin"
        ? copy.originBuiltin
        : origin === "workspace"
          ? copy.originWorkspace
          : copy.originGlobal,
    [copy],
  );

  const actionLabel = useCallback(
    (action: AgentRuleMatch["action"]) =>
      action === "block"
        ? copy.actionBlock
        : action === "require_approval"
          ? copy.actionRequireApproval
          : copy.actionWarn,
    [copy],
  );

  const draftNameError = useMemo(() => {
    const name = draft?.name.trim() ?? "";
    if (!name) return null;
    return RULE_NAME_PATTERN.test(name) ? null : copy.nameHint;
  }, [draft?.name, copy.nameHint]);

  const openCreateDraft = useCallback(() => {
    setDraftError(null);
    setDraft({ name: "", content: RULE_TEMPLATE });
  }, []);

  const handleCreate = useCallback(async () => {
    if (!draft || draftBusy || !workspaceDir) return;
    const name = draft.name.trim();
    if (!name || draftNameError) return;
    setDraftBusy(true);
    setDraftError(null);
    try {
      // The form's name field is the file stem; keep the frontmatter `name:`
      // line in sync so the two can never disagree (the backend refuses that).
      const content = draft.content
        .replace(/^name:\s*.*$/m, `name: ${name}`)
        .replace(/\{name\}/g, name);
      const path = await invokeMutation<string>("write_workspace_rule", {
        workspaceDir,
        name,
        content,
      });
      setNotice(formatPanelCopy(copy.savedAt, { path }));
      setDraft(null);
      await refresh(workspaceDir);
    } catch (err) {
      setDraftError(String(err));
    } finally {
      setDraftBusy(false);
    }
  }, [draft, draftBusy, draftNameError, workspaceDir, copy.savedAt, refresh]);

  if (!open) return null;

  return (
    <div className="ai-workspace-modal-layer">
      <div
        className="ai-workspace-modal ai-skills-manager-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-rules-manager-title"
      >
        <div className="ai-workspace-modal-header">
          <div className="ai-workspace-modal-copy">
            <span className="ai-workspace-modal-kicker">Guardrails</span>
            <h3 className="ai-workspace-modal-title" id="ai-rules-manager-title">
              {copy.title}
            </h3>
            <span className="ai-skills-manager-detail-meta">{copy.subtitle}</span>
          </div>
          <button
            type="button"
            className="ai-workspace-modal-close"
            onClick={onClose}
            aria-label={copy.close}
            title={copy.close}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="ai-skills-manager-body">
          {draft ? (
            <form
              className="ai-skills-manager-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void handleCreate();
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
                  <span className="ai-skills-manager-editor-title">{copy.newRule}</span>
                  <span className="ai-skills-manager-editor-sub">
                    {workspaceDir ? `${workspaceDir}/rules/${draft.name.trim() || "name"}.md` : ""}
                  </span>
                </div>
                <div className="ai-skills-manager-editor-actions">
                  <button
                    type="button"
                    className="ai-skills-manager-btn is-ghost"
                    onClick={() => setDraft(null)}
                  >
                    {copy.cancel}
                  </button>
                  <button
                    type="submit"
                    className="ai-skills-manager-btn is-primary"
                    disabled={!draft.name.trim() || draftNameError !== null || draftBusy}
                  >
                    {draftBusy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Check className="w-3.5 h-3.5" />
                    )}
                    {draftBusy ? copy.creating : copy.create}
                  </button>
                </div>
              </div>

              <div className="ai-skills-manager-fields">
                <label className="ai-skills-manager-field is-wide">
                  <span className="ai-skills-manager-field-label">{copy.nameLabel}</span>
                  <input
                    type="text"
                    value={draft.name}
                    aria-label={copy.nameLabel}
                    autoFocus
                    maxLength={64}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="no-drop-table"
                    aria-invalid={draftNameError !== null}
                    onChange={(event) =>
                      setDraft((current) =>
                        current ? { ...current, name: event.target.value } : current,
                      )
                    }
                  />
                  <span
                    className={`ai-skills-manager-field-hint ${draftNameError ? "is-error" : ""}`}
                    role={draftNameError ? "alert" : undefined}
                  >
                    {copy.nameHint}
                  </span>
                </label>

                <label className="ai-skills-manager-field is-wide is-grow">
                  <span className="ai-skills-manager-field-label">{copy.contentLabel}</span>
                  <textarea
                    value={draft.content}
                    aria-label={copy.contentLabel}
                    spellCheck={false}
                    onChange={(event) =>
                      setDraft((current) =>
                        current ? { ...current, content: event.target.value } : current,
                      )
                    }
                  />
                  <span className="ai-skills-manager-field-hint">{copy.contentHint}</span>
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
                <span className="ai-skills-manager-stat">
                  <strong>{formatPanelCopy(copy.armedCount, { count: rules.length })}</strong>
                </span>
                <div className="ai-skills-manager-actions">
                  <button
                    type="button"
                    className="ai-skills-manager-btn is-primary"
                    onClick={openCreateDraft}
                    disabled={!workspaceDir}
                    title={workspaceDir ? copy.newRule : copy.noWorkspaceTitle}
                  >
                    <Plus className="w-3.5 h-3.5" /> {copy.newRule}
                  </button>
                  <button
                    type="button"
                    className="ai-skills-manager-btn is-icon"
                    onClick={() => void refresh(workspaceDir)}
                    disabled={loading}
                    title={copy.refresh}
                    aria-label={copy.refresh}
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
              {loadErrors.length > 0 ? (
                <div className="ai-skills-manager-error" role="alert">
                  <TriangleAlert className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>
                    {copy.errorsTitle}: {loadErrors.join(" · ")}
                  </span>
                </div>
              ) : null}

              {rules.length === 0 ? (
                <div className="ai-skills-manager-empty">{loading ? copy.loading : copy.empty}</div>
              ) : (
                <ul className="ai-settings-sidebar-list ai-skills-manager-list">
                  {rules.map((rule) => (
                    <li key={`${rule.origin}-${rule.name}`}>
                      <div className="ai-settings-sidebar-item ai-skills-manager-row">
                        <span className="ai-settings-sidebar-item-icon" aria-hidden="true">
                          {rule.name.charAt(0).toUpperCase()}
                        </span>
                        <span className="ai-settings-sidebar-item-name" title={rule.description}>
                          {rule.name}
                        </span>
                        <span className="ai-skills-manager-row-tags">
                          <span className="ai-skills-manager-tag">{originLabel(rule.origin)}</span>
                          <span className="ai-skills-manager-tag">{actionLabel(rule.action)}</span>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
