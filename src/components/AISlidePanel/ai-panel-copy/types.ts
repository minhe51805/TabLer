/**
 * Strings for the AI panel additions that are not part of the workspace-chat
 * copy pack: the per-run cost line and the guardrail rules manager.
 *
 * Templates use `{placeholder}` interpolation via `formatPanelCopy`.
 */
export interface AIPanelCopy {
  /** Footer line under a finished assistant turn. */
  runCost: {
    /** e.g. "{used} / {budget} tokens" */
    label: string;
    title: string;
  };
  /** Collapsible "Run details" audit section on a finished agent run. */
  runDetails: {
    /** Section toggle label. */
    label: string;
    /** e.g. "{count} tool calls" */
    callCount: string;
    /** e.g. "Total {duration}" */
    total: string;
    /** Per-call status chip for a successful tool call. */
    ok: string;
    /** Per-call status chip for a failed/blocked tool call. */
    failed: string;
    /** Caption above the SQL a tool call executed. */
    sqlLabel: string;
  };
  /** Per-response controls on a finished assistant turn: regenerate + 👍/👎. */
  responseActions: {
    /** Regenerate button label + tooltip. */
    regenerate: string;
    /** Tooltip while a regenerate run is in flight. */
    regenerating: string;
    /** Toast title when the regenerated run fails and the old answer stays. */
    regenerateFailed: string;
    /** 👍 tooltip. */
    helpful: string;
    /** 👎 tooltip. */
    notHelpful: string;
    /** 👎 popover heading ("what was wrong?"). */
    feedbackTitle: string;
    /** 👎 popover free-text placeholder. */
    feedbackPlaceholder: string;
    /** 👎 popover submit button. */
    feedbackSubmit: string;
    /** Toast title after 👎 feedback was saved to agent memory. */
    feedbackSaved: string;
    /** Toast title when saving feedback failed. */
    feedbackFailed: string;
    /** Preset reason chips inside the 👎 popover. */
    feedbackReasons: {
      wrongSql: string;
      misunderstood: string;
      tooSlow: string;
      other: string;
    };
  };
  /** Guardrail rules manager modal. */
  rules: {
    title: string;
    subtitle: string;
    close: string;
    newRule: string;
    /** Tooltip on the disabled "New rule" button when no folder is linked. */
    noWorkspaceTitle: string;
    refresh: string;
    loading: string;
    empty: string;
    /** e.g. "{count} armed" */
    armedCount: string;
    errorsTitle: string;
    nameLabel: string;
    nameHint: string;
    contentLabel: string;
    contentHint: string;
    cancel: string;
    create: string;
    creating: string;
    /** e.g. "Saved rule at: {path}" */
    savedAt: string;
    originBuiltin: string;
    originGlobal: string;
    originWorkspace: string;
    actionWarn: string;
    actionRequireApproval: string;
    actionBlock: string;
  };
}
