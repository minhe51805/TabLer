import type { normalizeAIRequestError } from "../../utils/ai-request-errors";
import type { AIWorkspaceBubbleData } from "./ai-workspace-types";
import type { getAIWorkspaceCopy } from "./ai-workspace-copy";

type AIWorkspaceCopy = ReturnType<typeof getAIWorkspaceCopy>;

function stripCodeFences(text: string) {
  return text
    .replace(/```sql?/gi, "")
    .replace(/```/g, "")
    .trim();
}

export function summarizeAIResponse(rawResponse: string, sql?: string | null) {
  const cleaned = stripCodeFences(rawResponse).replace(/\s+/g, " ").trim();
  const compactSql = sql?.replace(/\s+/g, " ").trim() || "";
  if (cleaned && (!compactSql || cleaned !== compactSql)) {
    return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
  }
  const firstLine =
    (sql || "").split("\n").find((line) => line.trim().length > 0) ?? sql ?? cleaned;
  return firstLine.length > 180 ? `${firstLine.slice(0, 177)}...` : firstLine;
}

export function buildAIExecutionDetail(summary: string, query: string, previousDetail?: string) {
  return [
    previousDetail?.trim() || "",
    `## Execution\n\n${summary}`,
    `## Query\n\n\`\`\`sql\n${query}\n\`\`\``,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function buildAIAutoRunFailureDetail(message: string, sql: string, previousDetail?: string) {
  return [
    previousDetail?.trim() || "",
    `## Auto Run Error\n\n${message}`,
    `## Proposed SQL\n\n\`\`\`sql\n${sql}\n\`\`\``,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function buildAIRequestFailureBubble(
  bubble: AIWorkspaceBubbleData,
  requestError: ReturnType<typeof normalizeAIRequestError>,
  wasCancelled: boolean,
  aiCopy: AIWorkspaceCopy,
): AIWorkspaceBubbleData {
  const message = wasCancelled ? "AI request cancelled." : requestError.message;
  // A provider that died mid-stream already sent part of the answer — keep it
  // next to the error instead of discarding what the user watched arrive.
  const partialText =
    "partialText" in requestError && typeof requestError.partialText === "string"
      ? requestError.partialText.trim() || undefined
      : undefined;
  const hasPartialEvidence =
    Boolean(partialText) ||
    (bubble.agentSteps?.some((step) => step.action !== "plan" && step.status !== "running") ??
      false);

  // A step still marked "running" when the run died would spin forever —
  // settle it as an error so the trace reads as finished-with-failure.
  const settledSteps = bubble.agentSteps?.map((step) =>
    step.status === "running" ? { ...step, status: "error" as const } : step,
  );

  if (hasPartialEvidence) {
    return {
      ...bubble,
      kind: "assistant",
      status: "partial",
      settledAt: Date.now(),
      title: aiCopy.bubbleStates.partialTitle,
      subtitle: aiCopy.bubbleStates.partialSubtitle,
      preview: partialText ?? message,
      detail: partialText ? `${partialText}\n\n---\n\n${message}` : message,
      sql: undefined,
      risk: undefined,
      agentSteps: settledSteps,
      requestErrorCode: wasCancelled ? "cancelled" : requestError.code,
      retryable: true,
      autoDismissAt: undefined,
    };
  }

  if (wasCancelled) {
    return {
      ...bubble,
      kind: "assistant",
      status: "cancelled",
      settledAt: Date.now(),
      title: aiCopy.bubbleStates.cancelledTitle,
      subtitle: aiCopy.bubbleStates.cancelledSubtitle,
      preview: message,
      detail: message,
      sql: undefined,
      agentSteps: settledSteps,
      requestErrorCode: "cancelled",
      retryable: true,
      autoDismissAt: undefined,
    };
  }

  return {
    ...bubble,
    kind: "error",
    status: "error",
    settledAt: Date.now(),
    title: aiCopy.bubbleStates.errorTitle,
    subtitle: aiCopy.bubbleStates.errorSubtitle,
    preview: message,
    detail: message,
    sql: undefined,
    agentSteps: settledSteps,
    requestErrorCode: requestError.code,
    retryable: requestError.retryable,
    autoDismissAt: undefined,
  };
}
