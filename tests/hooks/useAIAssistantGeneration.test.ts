import { describe, expect, it } from "vitest";

import {
  buildAIAutoRunFailureDetail,
  buildAIExecutionDetail,
  buildAIRequestFailureBubble,
  summarizeAIResponse,
} from "@/components/AISlidePanel/hooks/use-ai-assistant-generation";
import { getAIWorkspaceCopy } from "@/components/AISlidePanel/ai-workspace-copy";
import type { AIWorkspaceBubbleData } from "@/components/AISlidePanel/ai-workspace-types";
import { AIRequestError } from "@/utils/ai-request-errors";

const copy = getAIWorkspaceCopy("en");
const loadingBubble: AIWorkspaceBubbleData = {
  id: "bubble-1",
  threadId: "thread-1",
  workspaceKey: "workspace-1",
  interactionMode: "agent",
  kind: "assistant",
  status: "loading",
  title: "Loading",
  subtitle: "Waiting",
  prompt: "Inspect orders",
  preview: "Working",
  detail: "",
  sql: "SELECT * FROM orders",
  x: 0,
  y: 0,
  pointer: { visible: false, x: 0, y: 0 },
  createdAt: 1,
  autoDismissAt: 2,
};

describe("AI assistant generation state", () => {
  it("summarizes model responses without leaking markdown fences", () => {
    expect(summarizeAIResponse("```sql\nSELECT 1;\n```", "SELECT 1;")).toBe("SELECT 1;");
    expect(summarizeAIResponse("Use the indexed column.\n\nSELECT 1;", "SELECT 1;")).toBe(
      "Use the indexed column. SELECT 1;",
    );
    expect(summarizeAIResponse("x".repeat(220))).toHaveLength(180);
    expect(summarizeAIResponse("x".repeat(220))).toMatch(/\.\.\.$/);
  });

  it("builds auditable success and auto-run failure details", () => {
    expect(buildAIExecutionDetail("2 rows", "SELECT 1;", "Model answer")).toContain(
      "## Execution\n\n2 rows",
    );
    expect(buildAIExecutionDetail("2 rows", "SELECT 1;")).toContain("```sql\nSELECT 1;\n```");
    expect(buildAIAutoRunFailureDetail("Permission denied", "DELETE FROM users")).toContain(
      "## Proposed SQL\n\n```sql\nDELETE FROM users\n```",
    );
  });

  it("maps an explicitly cancelled request to a retryable cancelled bubble", () => {
    const bubble = buildAIRequestFailureBubble(
      loadingBubble,
      new AIRequestError("cancelled", "Cancelled", true),
      true,
      copy,
    );

    expect(bubble).toMatchObject({
      kind: "assistant",
      status: "cancelled",
      title: copy.bubbleStates.cancelledTitle,
      requestErrorCode: "cancelled",
      retryable: true,
      sql: undefined,
      autoDismissAt: undefined,
    });
    expect(bubble.preview).toBe("AI request cancelled.");
  });

  it("preserves completed agent evidence as a partial response", () => {
    const bubble = buildAIRequestFailureBubble(
      {
        ...loadingBubble,
        agentSteps: [
          {
            step: 1,
            action: "run_readonly_sql",
            message: "Inspect totals",
            observation: "2 rows",
            status: "done",
          },
        ],
      },
      new AIRequestError("timeout", "Provider timed out", true),
      false,
      copy,
    );

    expect(bubble).toMatchObject({
      kind: "assistant",
      status: "partial",
      title: copy.bubbleStates.partialTitle,
      requestErrorCode: "timeout",
      retryable: true,
    });
    expect(bubble.agentSteps).toHaveLength(1);
    expect(bubble.preview).toBe("Provider timed out");
  });

  it("maps provider failures to their typed retry policy", () => {
    const retryable = buildAIRequestFailureBubble(
      loadingBubble,
      new AIRequestError("provider", "Rate limit reached", true),
      false,
      copy,
    );
    const terminal = buildAIRequestFailureBubble(
      loadingBubble,
      new AIRequestError("unknown", "Invalid local state", false),
      false,
      copy,
    );

    expect(retryable).toMatchObject({
      kind: "error",
      status: "error",
      requestErrorCode: "provider",
      retryable: true,
    });
    expect(terminal).toMatchObject({
      requestErrorCode: "unknown",
      retryable: false,
    });
  });
});
