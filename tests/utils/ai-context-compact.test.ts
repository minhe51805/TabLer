import { describe, expect, it } from "vitest";
import { buildCompactTranscript, buildCompactUserPrompt, buildPostCompactHistory, buildWorkspaceContextMessages, deriveMemoryTitle, extractDigestFromReply, extractMemoryKeywords, isCompactCommand, estimateTokensFromChars, formatTokensCompact } from "../../src/utils/ai-context-compact";
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
  it("carries the digest ALONE — the essence of the whole conversation, no verbatim scrollback", () => {
    // Claude Code / opencode semantics: the digest summarizes the ENTIRE
    // conversation up to the compact point (including the last turns), so
    // nothing verbatim survives beside it — otherwise those turns would be
    // double-billed and the digest would not be the single source of truth.
    const bubbles = Array.from({ length: 6 }, (_, index) =>
      makeBubble({
        id: `bubble-${index}`,
        createdAt: 1_000 + index,
        prompt: `question ${index}`,
        detail: `answer ${index}`,
      }),
    );
    const messages = buildPostCompactHistory("digest body", bubbles, 5_000);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("digest body");
    expect(messages[1].role).toBe("assistant");
    const flattened = messages.map((message) => message.content).join("\n");
    for (const bubble of bubbles) {
      expect(flattened).not.toContain(bubble.prompt!);
      expect(flattened).not.toContain(bubble.detail!);
    }
  });

  it("truncates an oversized digest to the char budget", () => {
    const messages = buildPostCompactHistory("d".repeat(9_000), [], 500);
    expect(messages[0].content.length).toBeLessThan(700);
    expect(messages[0].content.endsWith("…")).toBe(true);
  });
});

describe("extractMemoryKeywords", () => {
  it("ranks qualified identifiers highest and includes snake_case tokens", () => {
    const digest = [
      "## Objective",
      "- Keep tracking the migration of dbo.taikhoan to the new schema.",
      "",
      "## Agreements",
      "- The achievement_tiers table maps onto public.achievement_tiers.",
      "- We agreed to keep the sync worker idempotent.",
    ].join("\n");

    const keywords = extractMemoryKeywords(digest);

    expect(keywords).toContain("dbo.taikhoan");
    expect(keywords.indexOf("achievement_tiers")).toBeLessThan(keywords.indexOf("dbo.taikhoan"));
    expect(keywords).toContain("public.achievement_tiers");
    expect(keywords.some((keyword) => keyword === "keep" || keyword === "table")).toBe(false);
  });

  it("caps the keyword list and lowercases everything", () => {
    const keywords = extractMemoryKeywords(
      "DBO.TaiKhoan dbo.taikhoan order_items order_items order_items " +
        Array.from({ length: 30 }, (_, index) => `extra_${index}`).join(" "),
      5,
    );

    expect(keywords).toHaveLength(5);
    expect(keywords.every((keyword) => keyword === keyword.toLowerCase())).toBe(true);
  });
});

describe("deriveMemoryTitle", () => {
  it("uses the first Objective bullet as the title", () => {
    const digest = "## Objective\n- Migrate dbo.taikhoan to Postgres\n\n## Agreements\n- None";
    expect(deriveMemoryTitle(digest, "fallback")).toBe("Migrate dbo.taikhoan to Postgres");
  });

  it("falls back to the first non-header line, then the fallback", () => {
    expect(deriveMemoryTitle("# Summary\nTối ưu câu query báo cáo", "fallback")).toBe(
      "Tối ưu câu query báo cáo",
    );
    expect(deriveMemoryTitle("", "Thread #3")).toBe("Thread #3");
  });

  it("truncates very long titles", () => {
    const title = deriveMemoryTitle("- " + "x".repeat(200), "fallback");
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title.endsWith("...")).toBe(true);
  });
});

describe("token display helpers", () => {
  it("estimates tokens with ceiling (never under-reports)", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(15)).toBe(4);
    expect(estimateTokensFromChars(16)).toBe(4);
  });

  it("formats tokens like Claude-Code-style meters", () => {
    expect(formatTokensCompact(999)).toBe("999");
    expect(formatTokensCompact(24_000)).toBe("24k");
    expect(formatTokensCompact(326_100)).toBe("326.1k");
    expect(formatTokensCompact(1_000_000)).toBe("1M");
    expect(formatTokensCompact(2_400_000)).toBe("2.4M");
  });
});
