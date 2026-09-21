import type { AIPanelCopy } from "./types";

export const EN_PANEL_COPY: AIPanelCopy = {
  runCost: {
    label: "{used} / {budget} tokens",
    title: "Model tokens this run used, against the per-run budget.",
  },
  rules: {
    title: "Guardrail rules",
    subtitle:
      "Markdown rules in <workspace>/rules and the built-in pack vet every statement the agent runs.",
    close: "Close",
    newRule: "New rule",
    noWorkspaceTitle:
      "Link a folder to this workspace first — workspace rules live in <folder>/rules.",
    refresh: "Reload the list",
    loading: "Loading…",
    empty: "No rules armed.",
    armedCount: "{count} armed",
    errorsTitle: "Files that failed to load",
    nameLabel: "Rule name",
    nameHint: "Lowercase letters, digits, '-' and '_' (1-64). Becomes <name>.md.",
    contentLabel: "Rule file (.md)",
    contentHint: "Frontmatter + body. The file is validated before it is written.",
    cancel: "Cancel",
    create: "Create rule",
    creating: "Creating…",
    savedAt: "Saved rule at: {path}",
    originBuiltin: "built-in",
    originGlobal: "global",
    originWorkspace: "workspace",
    actionWarn: "warn",
    actionRequireApproval: "needs approval",
    actionBlock: "block",
  },
};
