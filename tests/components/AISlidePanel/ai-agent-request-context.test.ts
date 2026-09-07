import { describe, expect, it } from "vitest";
import {
  MAX_REMOTE_HISTORY_MESSAGES,
  resolveAgentRequestContext,
} from "@/components/AISlidePanel/ai-agent-request-context";
import type { AIConversationMessage } from "@/types/ai";

function msg(id: number): AIConversationMessage {
  return { id: `m${id}`, role: "user", content: `hello ${id}` } as unknown as AIConversationMessage;
}

const base = {
  prompt: "show me users",
  interactionMode: "prompt" as const,
  connectionId: "conn-1",
  isLocalProvider: false,
  history: [msg(1), msg(2), msg(3), msg(4), msg(5), msg(6)],
};

describe("resolveAgentRequestContext", () => {
  it("trims the prompt and derives requestIntentPrompt from userPrompt when present", () => {
    const ctx = resolveAgentRequestContext({ ...base, prompt: "  hi  ", userPrompt: " draw chart " });
    expect(ctx.normalizedPrompt).toBe("hi");
    expect(ctx.requestIntentPrompt).toBe("draw chart");
  });

  it("falls back to normalized prompt when no userPrompt", () => {
    const ctx = resolveAgentRequestContext(base);
    expect(ctx.requestIntentPrompt).toBe("show me users");
  });

  it("enables workspace tools in agent mode only with a live connection", () => {
    const withConn = resolveAgentRequestContext({
      ...base,
      interactionMode: "agent" as never,
      connectionId: "c1",
    });
    expect(withConn.agentCanUseWorkspace).toBe(true);
    expect(withConn.needsWorkspaceContext).toBe(true);

    const withoutConn = resolveAgentRequestContext({
      ...base,
      prompt: "hello there",
      interactionMode: "agent" as never,
      connectionId: null,
    });
    expect(withoutConn.agentCanUseWorkspace).toBe(false);
    // general intent without a connection stays non-workspace
    expect(withoutConn.needsWorkspaceContext).toBe(false);
  });

  it("marks workspace-scoped intents (sql) as needing context even outside agent mode", () => {
    const ctx = resolveAgentRequestContext({ ...base, prompt: "write sql to join orders" });
    expect(ctx.assistIntent).toBe("sql");
    expect(ctx.needsWorkspaceContext).toBe(true);
  });

  it("keeps full history for local providers", () => {
    const ctx = resolveAgentRequestContext({
      ...base,
      isLocalProvider: true,
      history: Array.from({ length: 10 }, (_, i) => msg(i)),
    });
    expect(ctx.requestHistory).toHaveLength(10);
  });

  it(`caps remote provider history at ${MAX_REMOTE_HISTORY_MESSAGES} messages`, () => {
    const ctx = resolveAgentRequestContext(base);
    expect(ctx.requestHistory).toHaveLength(MAX_REMOTE_HISTORY_MESSAGES);
  });

  it("drops history entirely for overview intent", () => {
    const ctx = resolveAgentRequestContext({ ...base, prompt: "give me an overview of the database" });
    expect(ctx.assistIntent).toBe("overview");
    expect(ctx.requestHistory).toHaveLength(0);
  });

  it("disables schema-context mode for plain prompt mode", () => {
    const ctx = resolveAgentRequestContext(base);
    expect(ctx.modeUsesSchemaContext).toBe(false);
  });

  it("detects visualization and metrics-board signals from the prompt", () => {
    const viz = resolveAgentRequestContext({ ...base, prompt: "vẽ biểu đồ doanh thu" });
    expect(viz.wantsVisualization).toBe(true);

    const board = resolveAgentRequestContext({ ...base, prompt: "tạo metrics board cho sales" });
    expect(board.wantsMetricsBoard).toBe(true);
  });
});
