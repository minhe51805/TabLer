import { splitSqlStatements } from "../../utils/sqlStatements";

export interface SelectionContextState {
  text: string;
  source: string;
  boardId?: string;
  rect: { x: number; y: number; width: number; height: number } | null;
  updatedAt: number;
}

export function buildExecutionDetail(summary: string, query: string, previousDetail?: string) {
  return [previousDetail?.trim() || "", "## Execution", summary, "## Query", `\`\`\`sql\n${query}\n\`\`\``]
    .filter(Boolean).join("\n\n---\n\n");
}

export function buildSelectionDraftPrompt(selection: SelectionContextState) {
  return [`Explain this ${selection.source} and suggest a better version if needed.`, "", selection.text].join("\n");
}

export function buildPromptWithSelection(prompt: string, selection: SelectionContextState | null) {
  const normalizedPrompt = prompt.trim();
  if (!selection?.text.trim()) return normalizedPrompt;
  if (!normalizedPrompt) return buildSelectionDraftPrompt(selection);
  return [`Use this ${selection.source} as context for the request below.`, "", `User request: ${normalizedPrompt}`, "", "Selected content:", selection.text].join("\n");
}

export function isSingleSqlStatement(sql: string) {
  try { return splitSqlStatements(sql).length === 1; } catch { return false; }
}

export function getSelectionRect(range: Range | null) {
  if (!range) return null;
  const rect = range.getBoundingClientRect();
  return !rect.width && !rect.height ? null : { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

export function getSelectionFromActiveElement(activeElement: Element | null) {
  if (!(activeElement instanceof HTMLTextAreaElement) && !(activeElement instanceof HTMLInputElement && typeof activeElement.selectionStart === "number")) return null;
  const start = activeElement.selectionStart ?? 0;
  const end = activeElement.selectionEnd ?? 0;
  if (start === end) return null;
  const text = activeElement.value.slice(start, end).trim();
  if (!text) return null;
  const rect = activeElement.getBoundingClientRect();
  return { text, source: activeElement instanceof HTMLTextAreaElement ? "text input" : "inline field", rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
}
