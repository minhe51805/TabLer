import { describe, expect, it } from "vitest";
import {
  buildCompactTranscript,
  buildCompactUserPrompt,
  buildPostCompactHistory,
  buildWorkspaceContextMessages,
  extractDigestFromReply,
  isCompactCommand,
} from "../../src/utils/ai-context-compact";
import { buildAIWorkspaceKey } from "../../src/components/AISlidePanel/ai-conversation-state";
import type { AIWorkspaceBubbleData } from "../../src/components/AISlidePanel/ai-workspace-types";

function makeBubble(overrides: Partial<AIWorkspaceBubbleData>): AIWorkspaceBubbleData {
  return {
    id: "bubble-1",
    threadId: "thread-1",
    workspaceKey: "conn::db",
    interactionMode: "prompt",
    kind: "assistant",
    status: "ready",
    title: "Answer",
    subtitle: "",
    prompt: "User prompt",
    preview: "Short answer",
    detail: "Long answer body",
    x: 0,
    y: 0,
    pointer: { x: 0, y: 0, visible: false },
    createdAt: 1_000,
    ...overrides,
  };
}

describe("isCompactCommand", () => {
  it("matches /compact ignoring case and surrounding spaces", () => {
    expect(isCompactCommand("/compact")).toBe(true);
    expect(isCompactCommand("  /Compact  ")).toBe(true);
  });

  it("rejects other prompts", () => {
    expect(isCompactCommand("/compact extra")).toBe(false);
    expect(isCompactCommand("select * from dbo.taikhoan")).toBe(false);
    expect(isCompactCommand("")).toBe(false);
  });
});

describe("buildAIWorkspaceKey", () => {
  it("scopes to the user workspace when one is active", () => {
    expect(buildAIWorkspaceKey("conn-1", "ant_language", "ws-42")).toBe("uw:ws-42");
  });

  it("falls back to the connection/database key in auto mode", () => {
    expect(buildAIWorkspaceKey("conn-1", "ant_language")).toBe("conn-1::ant_language");
    expect(buildAIWorkspaceKey("conn-1", "ant_language", null)).toBe("conn-1::ant_language");
  });
});

describe("buildCompactTranscript", () => {
  it("sorts bubbles chronologically and skips loading ones", () => {
    const transcript = buildCompactTranscript([
      makeBubble({ id: "late", createdAt: 2_000, prompt: "second question", detail: "second answer" }),
      makeBubble({ id: "loading", createdAt: 3_000, status: "loading" }),
      makeBubble({ id: "early", createdAt: 1_000, prompt: "first question", detail: "first answer" }),
    ]);

    const firstIndex = transcript.indexOf("first question");
    const secondIndex = transcript.indexOf("second question");
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(transcript).toContain("Assistant: first answer");
  });

  it("keeps error bubbles as ERROR lines", () => {
    const transcript = buildCompactTranscript([
      makeBubble({ kind: "error", status: "error", title: "Query failed", subtitle: "timeout" }),
    ]);
    expect(transcript).toContain("ERROR: Query failed — timeout");
  });
});

describe("buildCompactUserPrompt", () => {
  it("embeds workspace name, template and transcript on first compact", () => {
    const prompt = buildCompactUserPrompt("USER: hi", "", "QL_BAN_HANG");
    expect(prompt).toContain("Target workspace: QL_BAN_HANG");
    expect(prompt).toContain("<conversation>");
    expect(prompt).toContain("USER: hi");
    expect(prompt).toContain("## Objective");
    expect(prompt).toContain("## Work State");
    expect(prompt).not.toContain("<prior-summary>");
  });

  it("re-anchors with the prior summary on later compacts", () => {
    const prompt = buildCompactUserPrompt("USER: hi", "old digest", "QL_BAN_HANG");
    expect(prompt).toContain("<prior-summary>");
    expect(prompt).toContain("old digest");
    expect(prompt).toContain("Update it so it still holds everything relevant");
    expect(prompt).toContain("## Objective");
  });
});

describe("extractDigestFromReply", () => {
  it("strips a chatty preamble", () => {
    const reply = "Here's the digest you asked for:\n- Goal: migrate data";
    expect(extractDigestFromReply(reply)).toBe("- Goal: migrate data");
  });

  it("returns the raw text when there is no preamble", () => {
    expect(extractDigestFromReply("- Goal: x")).toBe("- Goal: x");
  });
});

describe("buildWorkspaceContextMessages", () => {
  it("returns no messages without a digest", () => {
    expect(buildWorkspaceContextMessages(null)).toEqual([]);
    expect(buildWorkspaceContextMessages("   ")).toEqual([]);
  });

  it("wraps the digest as a user/assistant context pair", () => {
    const messages = buildWorkspaceContextMessages("Goal: x");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(messages[0].content).toContain("Goal: x");
    expect(messages[1]).toMatchObject({ role: "assistant" });
  });
});

describe("buildPostCompactHistory", () => {
  it("combines the digest pair with recent bubble history", () => {
    const bubbles = Array.from({ length: 6 }, (_, index) =>
      makeBubble({
        id: `bubble-${index}`,
        createdAt: 1_000 + index,
        prompt: `question ${index}`,
        detail: `answer ${index}`,
      }),
    );
    const messages = buildPostCompactHistory("digest body", bubbles, 5_000);

    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("digest body");
    expect(messages[1].role).toBe("assistant");
    const flattened = messages.map((message) => message.content).join("\n");
    expect(flattened).toContain("question 4");
    expect(flattened).toContain("question 5");
  });

  it("truncates an oversized digest to the char budget", () => {
    const messages = buildPostCompactHistory("d".repeat(9_000), [], 500);
    expect(messages[0].content.length).toBeLessThan(700);
    expect(messages[0].content.endsWith("…")).toBe(true);
  });
});
