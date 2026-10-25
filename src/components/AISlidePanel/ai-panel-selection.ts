import { splitSqlStatements } from "../../utils/sqlStatements";

export interface SelectionContextState {
  text: string;
  source: string;
  boardId?: string;
  rect: { x: number; y: number; width: number; height: number } | null;
  updatedAt: number;
}

export function buildExecutionDetail(summary: string, query: string, previousDetail?: string) {
  return [
    previousDetail?.trim() || "",
    "## Execution",
    summary,
    "## Query",
    `\`\`\`sql\n${query}\n\`\`\``,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function buildSelectionDraftPrompt(selection: SelectionContextState) {
  return [
    `Explain this ${selection.source} and suggest a better version if needed.`,
    "",
    selection.text,
  ].join("\n");
}

export function buildPromptWithSelection(prompt: string, selection: SelectionContextState | null) {
  const normalizedPrompt = prompt.trim();
  if (!selection?.text.trim()) return normalizedPrompt;
  if (!normalizedPrompt) return buildSelectionDraftPrompt(selection);
  return [
    `Use this ${selection.source} as context for the request below.`,
    "",
    `User request: ${normalizedPrompt}`,
    "",
    "Selected content:",
    selection.text,
  ].join("\n");
}

export function isSingleSqlStatement(sql: string) {
  try {
    return splitSqlStatements(sql).length === 1;
  } catch {
    return false;
  }
}
