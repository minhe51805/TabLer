import { describe, expect, it } from "vitest";
import {
  AI_WORKSPACE_HISTORY_LEGACY_STORAGE_KEY,
  AI_WORKSPACE_HISTORY_VERSION,
  buildAIWorkspaceKey,
  buildConversationHistoryMessages,
  buildThreadLabel,
  createEmptyPersistedAIWorkspaceState,
  hasPersistedAIWorkspaceStateData,
  getBubbleConversationText,
  loadLegacyPersistedAIWorkspaceState,
  prunePersistedAIWorkspaceState,
  type AIChatThread,
  type PersistedAIWorkspaceState,
} from "@/components/AISlidePanel/ai-conversation-state";
import type { AIWorkspaceBubbleData } from "@/components/AISlidePanel/ai-workspace-types";

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
});
