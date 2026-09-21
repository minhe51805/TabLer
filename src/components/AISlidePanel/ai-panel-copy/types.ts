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
