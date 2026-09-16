import { describe, expect, it } from "vitest";
import {
  AI_WORKSPACE_HISTORY_LEGACY_STORAGE_KEY,
  AI_WORKSPACE_HISTORY_VERSION,
  BACKEND_MAX_HISTORY_CHARS,
  BACKEND_MAX_HISTORY_MESSAGES,
  buildAIWorkspaceKey,
  buildConversationHistoryMessages,
  clampHistoryBudget,
  DEFAULT_HISTORY_BUDGET,
  resolveHistoryBudget,
  extractAskUserOptionsFromQuestion,
  stripAskUserTrailingOptions,
  buildThreadLabel,
  createEmptyPersistedAIWorkspaceState,
  hasPersistedAIWorkspaceStateData,
  estimateConversationFootprint,
  getBubbleConversationText,
  loadLegacyPersistedAIWorkspaceState,
  prunePersistedAIWorkspaceState,
  sanitizeAIWorkspaceAttachments,
  sanitizePersistedAIWorkspaceState,
  type AIChatThread,
  type PersistedAIWorkspaceState,
} from "@/components/AISlidePanel/ai-conversation-state";
import type {
  AIWorkspaceAttachment,
  AIWorkspaceBubbleData,
} from "@/components/AISlidePanel/ai-workspace-types";

function thread(id: string, workspaceKey = "connection::database", updatedAt = 1): AIChatThread {
  return {
    id,
    workspaceKey,
    label: id,
    createdAt: updatedAt,
    updatedAt,
    isAutoLabel: true,
  };
}

function bubble(
  id: string,
  threadId: string,
  overrides: Partial<AIWorkspaceBubbleData> = {},
): AIWorkspaceBubbleData {
  return {
    id,
    threadId,
    workspaceKey: "connection::database",
    interactionMode: "prompt",
    kind: "assistant",
    status: "ready",
    title: "Response",
    subtitle: "Ready",
    prompt: "Show tables",
    preview: "Done",
    detail: "Done",
    x: 0,
    y: 0,
    pointer: { x: 0, y: 0, visible: false },
    createdAt: 1,
    ...overrides,
  };
}

describe("AI conversation state", () => {
  it("builds stable workspace keys and compact thread labels", () => {
    expect(buildAIWorkspaceKey("connection-1", "analytics")).toBe("connection-1::analytics");
    expect(buildAIWorkspaceKey(null, null)).toBe("no-connection::no-database");
    expect(buildThreadLabel("   show   the latest customer activity today   ", 3))
      .toBe("show the latest custo...");
    expect(buildThreadLabel("   ", 3)).toBe("#3");
  });

  it("returns an empty state for missing or malformed legacy history", () => {
    const missingStorage = { getItem: () => null };
    const malformedStorage = { getItem: () => "{" };

    expect(loadLegacyPersistedAIWorkspaceState(missingStorage))
      .toEqual(createEmptyPersistedAIWorkspaceState());
    expect(loadLegacyPersistedAIWorkspaceState(malformedStorage))
      .toEqual(createEmptyPersistedAIWorkspaceState());
  });

  it("migrates valid legacy records and rejects malformed entries", () => {
    const legacyBubble = bubble("bubble-1", "thread-1");
    const storage = {
      getItem: (key: string) => key === AI_WORKSPACE_HISTORY_LEGACY_STORAGE_KEY
        ? JSON.stringify({
            version: 0,
            threads: [
              { id: "thread-1", workspaceKey: "connection::database", label: "Legacy", createdAt: 42 },
              { id: 7, workspaceKey: "invalid" },
            ],
            bubbles: [legacyBubble, { ...legacyBubble, id: "bad", interactionMode: "invalid" }],
            interactionModes: { "connection::database": "agent", invalid: "other" },
            activeThreadIds: { "connection::database": "thread-1", invalid: 4 },
          })
        : null,
    };

    const migrated = loadLegacyPersistedAIWorkspaceState(storage);

    expect(migrated.version).toBe(AI_WORKSPACE_HISTORY_VERSION);
    expect(migrated.threads).toEqual([
      expect.objectContaining({ id: "thread-1", updatedAt: 42, isAutoLabel: false }),
    ]);
    expect(migrated.bubbles.map((item) => item.id)).toEqual(["bubble-1"]);
    expect(migrated.interactionModes).toEqual({ "connection::database": "agent" });
    expect(migrated.activeThreadIds).toEqual({ "connection::database": "thread-1" });
  });

  it("prunes stale threads, loading bubbles, and orphaned workspace selections", () => {
    const threads = Array.from({ length: 13 }, (_, index) => thread(`thread-${index}`, undefined, index));
    const bubbles = [
      ...Array.from({ length: 25 }, (_, index) => bubble(`bubble-${index}`, "thread-12", { createdAt: index })),
      bubble("loading", "thread-12", { status: "loading", createdAt: 30 }),
      bubble("orphan", "thread-0", { createdAt: 31 }),
    ];
    const state: PersistedAIWorkspaceState = {
      version: AI_WORKSPACE_HISTORY_VERSION,
      threads,
      bubbles,
      interactionModes: { "connection::database": "edit", orphaned: "agent" },
      activeThreadIds: { "connection::database": "thread-12", orphaned: "missing" },
    };

    const pruned = prunePersistedAIWorkspaceState(state);

    expect(pruned.threads).toHaveLength(12);
    expect(pruned.threads.map((item) => item.id)).not.toContain("thread-0");
    expect(pruned.bubbles).toHaveLength(24);
    expect(pruned.bubbles.map((item) => item.id)).toEqual(
      Array.from({ length: 24 }, (_, index) => `bubble-${index + 1}`),
    );
    expect(pruned.interactionModes).toEqual({ "connection::database": "edit" });
    expect(pruned.activeThreadIds).toEqual({ "connection::database": "thread-12" });
    expect(hasPersistedAIWorkspaceStateData(pruned)).toBe(true);
    expect(hasPersistedAIWorkspaceStateData(createEmptyPersistedAIWorkspaceState())).toBe(false);
  });

  it("builds bounded user and assistant history without duplicating SQL", () => {
    const bubbles = Array.from({ length: 5 }, (_, index) => bubble(
      `bubble-${index}`,
      "thread-1",
      {
        createdAt: index,
        prompt: `User request:\nQuestion ${index}\n\nSelected content:\nignored`,
        detail: `Answer ${index}\n\nSELECT ${index}`,
        sql: `SELECT ${index}`,
      },
    ));

    const messages = buildConversationHistoryMessages(bubbles);

    expect(messages).toHaveLength(8);
    expect(messages[0]).toEqual({ role: "user", content: "Question 1" });
    expect(messages[1]).toEqual({ role: "assistant", content: "Answer 1" });
    expect(messages[messages.length - 1]).toEqual({ role: "assistant", content: "Answer 4" });
  });

  it("falls back to the preview when detail only repeats the SQL", () => {
    expect(getBubbleConversationText(bubble("bubble", "thread", {
      preview: "A concise explanation",
      detail: "```sql\nSELECT 1\n```",
      sql: "SELECT 1",
    }))).toBe("A concise explanation");
  });

  it("does not feed cancelled, partial, or failed attempts back into provider history", () => {
    const messages = buildConversationHistoryMessages([
      bubble("ready", "thread", { prompt: "First", detail: "Complete", status: "ready" }),
      bubble("partial", "thread", { prompt: "Second", detail: "Timed out", status: "partial" }),
      bubble("cancelled", "thread", { prompt: "Third", detail: "Cancelled", status: "cancelled" }),
      bubble("error", "thread", { prompt: "Fourth", detail: "Provider failed", status: "error" }),
    ]);

    expect(messages).toEqual([
      { role: "user", content: "First" },
      { role: "assistant", content: "Complete" },
    ]);
  });

  it("honors a larger budget: keeps more recent turns and trims to the budget's char cap", () => {
    const bubbles = Array.from({ length: 6 }, (_, index) =>
      bubble(`b${index}`, "thread", {
        createdAt: index,
        prompt: `Q${index}`,
        detail: "d".repeat(3_000),
        sql: undefined,
        status: "ready",
      }),
    );

    // Big-context models get a wider window: keep the last 5 turns (10 messages)
    // and allow up to 1,500 chars per message instead of the default 4 × 1,000.
    const messages = buildConversationHistoryMessages(bubbles, { maxBubbles: 5, maxMessageChars: 1_500 });

    expect(messages).toHaveLength(10);
    // The oldest of the six turns (b0) is dropped by the 5-turn window.
    expect(messages.some((message) => message.content === "Q0")).toBe(false);
    expect(messages.some((message) => message.content === "Q1")).toBe(true);
    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.content.length).toBeLessThanOrEqual(1_500);
    expect(assistant!.content.length).toBeGreaterThan(1_000);
    expect(assistant!.content.endsWith("...")).toBe(true);
  });
});

describe("resolveHistoryBudget", () => {
  it("uses the conservative default for unknown or small context windows", () => {
    expect(resolveHistoryBudget(null)).toEqual(DEFAULT_HISTORY_BUDGET);
    expect(resolveHistoryBudget(undefined)).toEqual(DEFAULT_HISTORY_BUDGET);
    expect(resolveHistoryBudget(0)).toEqual(DEFAULT_HISTORY_BUDGET);
    expect(resolveHistoryBudget(8_000)).toEqual(DEFAULT_HISTORY_BUDGET);
  });

  it("keeps fuller turns for medium-context models", () => {
    const budget = resolveHistoryBudget(32_000);
    expect(budget.maxBubbles).toBe(4);
    expect(budget.maxMessageChars).toBe(2_000);
  });

  it("keeps more, fuller turns for very large context models", () => {
    const budget = resolveHistoryBudget(1_000_000);
    expect(budget.maxBubbles).toBe(5);
    expect(budget.maxMessageChars).toBeGreaterThanOrEqual(2_000);
  });

  it("never proposes a window that could exceed the backend caps", () => {
    for (const tokens of [null, 0, 8_000, 32_000, 128_000, 1_000_000, 10_000_000]) {
      const budget = resolveHistoryBudget(tokens);
      // digest pair (2 messages) + this window's user/assistant messages
      expect(2 + budget.maxBubbles * 2).toBeLessThanOrEqual(BACKEND_MAX_HISTORY_MESSAGES);
      // full history characters must leave room under the char cap
      expect(budget.maxBubbles * 2 * budget.maxMessageChars).toBeLessThan(BACKEND_MAX_HISTORY_CHARS);
    }
  });
});

describe("clampHistoryBudget", () => {
  it("clamps an over-generous request down to the backend caps", () => {
    const clamped = clampHistoryBudget({ maxBubbles: 50, maxMessageChars: 100_000 });
    expect(2 + clamped.maxBubbles * 2).toBeLessThanOrEqual(BACKEND_MAX_HISTORY_MESSAGES);
    expect(clamped.maxBubbles * 2 * clamped.maxMessageChars).toBeLessThan(BACKEND_MAX_HISTORY_CHARS);
  });

  it("keeps at least one usable turn for degenerate inputs", () => {
    const clamped = clampHistoryBudget({ maxBubbles: 0, maxMessageChars: 0 });
    expect(clamped.maxBubbles).toBeGreaterThanOrEqual(1);
    expect(clamped.maxMessageChars).toBeGreaterThanOrEqual(200);
  });
});

describe("estimateConversationFootprint", () => {
  it("counts every ready bubble untrimmed — /compact must visibly shrink it", () => {
    const longSql = "x".repeat(50_000);
    const bubbles = [
      bubble("b1", "t", { prompt: "SELECT 1", detail: longSql }),
      bubble("b2", "t", { prompt: "y".repeat(20_000), detail: "answer" }),
    ];
    const footprint = estimateConversationFootprint(bubbles);
    // Untrimmed: well beyond the send-window cap (4 bubbles x 1k) that used to
    // make the meter freeze at ~10k regardless of conversation size.
    expect(footprint).toBeGreaterThan(50_000);
  });

  it("excludes compacted and loading bubbles — compact drops the meter", () => {
    const compactedAt = 12345;
    const bubbles = [
      bubble("old", "t", { prompt: "a".repeat(30_000), compactedAt }),
      bubble("loading", "t", { prompt: "b".repeat(30_000), status: "loading" as const }),
      bubble("kept", "t", { prompt: "kept prompt", detail: "kept answer" }),
    ];
    const footprint = estimateConversationFootprint(bubbles);
    expect(footprint).toBe("kept prompt".length + "kept answer".length);
  });
});


describe("extractAskUserOptionsFromQuestion", () => {
  it("recovers a trailing numbered option list and removes it from the question", () => {
    const result = extractAskUserOptionsFromQuestion(
      "Bạn muốn xem gì?\n\n1. Sinh viên kèm tên ngành\n2. Danh sách học phần\n3. Top sinh viên",
    );
    expect(result.question).toBe("Bạn muốn xem gì?");
    expect(result.options).toEqual(["Sinh viên kèm tên ngành", "Danh sách học phần", "Top sinh viên"]);
  });

  it("recovers bulleted option lists", () => {
    const result = extractAskUserOptionsFromQuestion("Which schema?\n- dbo\n- sales");
    expect(result.question).toBe("Which schema?");
    expect(result.options).toEqual(["dbo", "sales"]);
  });

  it("ignores a single trailing list line (not a menu)", () => {
    const question = "Xem bảng SinhViens chứ?\n- bảng duy nhất";
    expect(extractAskUserOptionsFromQuestion(question)).toEqual({ question, options: [] });
  });

  it("keeps the question untouched when no trailing list exists", () => {
    const question = "Bạn muốn xem thông tin gì trong QuanLySinhVienDB?";
    expect(extractAskUserOptionsFromQuestion(question)).toEqual({ question, options: [] });
  });

  it("caps recovered options at 8", () => {
    const list = Array.from({ length: 12 }, (_, index) => `${index + 1}. Option ${index + 1}`).join("\n");
    const result = extractAskUserOptionsFromQuestion(`Chọn?\n${list}`);
    expect(result.options).toHaveLength(8);
    expect(result.question).toBe("Chọn?");
  });

  it("does not strip a list that is followed by more prose", () => {
    const question = "Danh sách gợi ý:\n1. A\n2. B\nBạn muốn bắt đầu từ đâu?";
    expect(extractAskUserOptionsFromQuestion(question)).toEqual({ question, options: [] });
  });
});

describe("stripAskUserTrailingOptions", () => {
  it("strips the numbered option block and the reply hint", () => {
    expect(
      stripAskUserTrailingOptions(
        "Bạn muốn xem gì?\n\n1. Bảng sinh viên\n2. Bảng điểm\n\n_(Trả lời bằng số thứ tự...)_",
      ),
    ).toBe("Bạn muốn xem gì?");
  });

  it("strips only the italic hint when no numbered block exists", () => {
    expect(
      stripAskUserTrailingOptions("Xác nhận nhé?\n\n_(Trả lời...)_"),
    ).toBe("Xác nhận nhé?");
  });

  it("leaves answers without ask_user markers untouched", () => {
    expect(stripAskUserTrailingOptions("Kết quả: 11 sinh viên.")).toBe("Kết quả: 11 sinh viên.");
  });
});

describe("sanitizePersistedAIWorkspaceState", () => {
  it("drops null and malformed bubbles so hydration cannot crash on them", () => {
    const state: PersistedAIWorkspaceState = createEmptyPersistedAIWorkspaceState();
    state.threads = [thread("t1")];
    const rawBubbles: unknown[] = [
      null,
      { id: "b1" }, // missing every required field
      bubble("b2", "t1"),
    ];
    state.bubbles = rawBubbles as PersistedAIWorkspaceState["bubbles"];

    const sanitized = sanitizePersistedAIWorkspaceState(state);

    expect(sanitized.bubbles.map((b) => b.id)).toEqual(["b2"]);
  });

  it("keeps well-formed attachment metadata and strips malformed entries", () => {
    const state: PersistedAIWorkspaceState = createEmptyPersistedAIWorkspaceState();
    state.threads = [thread("t1")];
    state.bubbles = [
      bubble("b1", "t1", {
        attachments: [
          { id: "a1", kind: "image", name: "shot.png", mimeType: "image/png", size: 1024, createdAt: 5 },
          // Malformed: missing mimeType and numeric size
          { id: "a2", kind: "image", name: "broken.png" } as unknown as AIWorkspaceAttachment,
          null,
        ] as unknown as AIWorkspaceBubbleData["attachments"],
      }),
    ];

    const sanitized = sanitizePersistedAIWorkspaceState(state);
    const attachments = sanitized.bubbles[0]?.attachments;

    expect(attachments).toHaveLength(1);
    expect(attachments?.[0]?.id).toBe("a1");
  });

  it("returns undefined attachments when nothing valid survives", () => {
    const state: PersistedAIWorkspaceState = createEmptyPersistedAIWorkspaceState();
    state.threads = [thread("t1")];
    state.bubbles = [
      bubble("b1", "t1", {
        attachments: [{ id: "bad" }] as unknown as AIWorkspaceBubbleData["attachments"],
      }),
    ];

    const sanitized = sanitizePersistedAIWorkspaceState(state);

    expect(sanitized.bubbles[0]?.attachments).toBeUndefined();
  });

  it("sanitizeAIWorkspaceAttachments passes through undefined and non-array inputs", () => {
    expect(sanitizeAIWorkspaceAttachments(undefined)).toBeUndefined();
    expect(sanitizeAIWorkspaceAttachments("nope")).toBeUndefined();
    expect(sanitizeAIWorkspaceAttachments([])).toBeUndefined();
  });

  it("backfills missing updatedAt from createdAt and filters invalid maps", () => {
    const state: PersistedAIWorkspaceState = createEmptyPersistedAIWorkspaceState();
    state.threads = [{ ...thread("t1", "conn::db", 7), updatedAt: undefined as unknown as number }];
    state.interactionModes = { t1: "agent", t2: "not-a-mode" } as unknown as PersistedAIWorkspaceState["interactionModes"];
    state.activeThreadIds = { "conn::db": "t1", broken: null } as unknown as PersistedAIWorkspaceState["activeThreadIds"];

    const sanitized = sanitizePersistedAIWorkspaceState(state);

    expect(sanitized.threads[0]?.updatedAt).toBe(7);
    expect(sanitized.interactionModes).toEqual({ t1: "agent" });
    expect(sanitized.activeThreadIds).toEqual({ "conn::db": "t1" });
  });
});

