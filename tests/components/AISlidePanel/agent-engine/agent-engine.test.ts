import { describe, expect, it, vi } from "vitest";
import {
  clampTranscriptObservation,
  createMultiTurnTranscript,
} from "@/components/AISlidePanel/agent-engine/multi-turn-transcript";
import { appendAgentFacts, parseAgentFacts } from "@/components/AISlidePanel/ai-agent-context";
import { AGENT_COMPACTION_TOKEN_THRESHOLD } from "@/components/AISlidePanel/ai-agent-cost";
import { runAIAgentToolLoop } from "@/components/AISlidePanel/ai-agent-runner";
import { parseCanonicalToolCall } from "@/components/AISlidePanel/ai-agent-tools";

describe("agent-engine multi-turn transcript & multi-tool batch execution", () => {
  it("preserves @@facts footer when clamping oversized transcript observations", () => {
    const raw = appendAgentFacts("Row ".repeat(1_500), {
      tables: ["orders"],
      rowsReturned: 42,
    });
    const clamped = clampTranscriptObservation(raw, 800);
    expect(clamped).toContain("[observation truncated]");
    const parsed = parseAgentFacts(clamped);
    expect(parsed.facts).toEqual({
      tables: ["orders"],
      rowsReturned: 42,
    });
  });

  it("pairs assistant tool_calls with tool_result turns and compacts only complete atomic groups", async () => {
    const transcript = createMultiTurnTranscript();

    for (let i = 1; i <= 5; i += 1) {
      transcript.recordAssistantToolTurn({
        text: `Inspecting table_${i}`,
        thoughtSignature: `sig_${i}`,
        toolCalls: [
          { id: `call_${i}_a`, name: "describe_table", arguments: { table: `table_${i}` } },
          { id: `call_${i}_b`, name: "sample_table_data", arguments: { table: `table_${i}` } },
        ],
        stepOrdinalHint: i * 2,
      });
      transcript.recordToolResult({
        callId: `call_${i}_a`,
        toolName: "describe_table",
        observation: `T=table_${i}|C:id:int!pk`,
        stepOrdinal: i * 2 - 1,
      });
      transcript.recordToolResult({
        callId: `call_${i}_b`,
        toolName: "sample_table_data",
        observation: `[{"id":${i}}]`,
        stepOrdinal: i * 2,
      });
    }

    expect(transcript.getTurns()).toHaveLength(15);

    const steps = Array.from({ length: 10 }, (_, idx) => ({
      step: idx + 1,
      action: (idx % 2 === 0 ? "describe_table" : "sample_table_data") as
        "describe_table" | "sample_table_data",
      message: `step ${idx + 1}`,
      observation: `obs ${idx + 1}`,
    }));

    await transcript.compactIfNeeded({
      steps,
      tokensUsed: AGENT_COMPACTION_TOKEN_THRESHOLD + 1_000,
      summarize: async () => "- Verified table_1..table_3 schemas and samples.",
    });

    expect(transcript.getCompactedContext()).toContain("Verified table_1..table_3");
    const remaining = transcript.getTurns();
    // Every remaining assistant turn MUST still be immediately followed by both of its tool_result turns!
    expect(remaining.length).toBeGreaterThanOrEqual(3);
    for (let idx = 0; idx < remaining.length;) {
      const turn = remaining[idx];
      expect(turn.role).toBe("assistant");
      if (turn.role === "assistant") {
        const expectedIds = (turn.tool_calls ?? []).map((c) => c.id);
        const resultIds = remaining
          .slice(idx + 1, idx + 1 + expectedIds.length)
          .map((t) => (t.role === "tool_result" ? t.call_id : ""));
        expect(resultIds).toEqual(expectedIds);
        idx += 1 + expectedIds.length;
      } else {
        idx += 1;
      }
    }
  });

  it("executes multi-tool native batches sequentially and emits 1:1 tool_result events (including budget skips)", async () => {
    const runTool = vi.fn(async (action: { action: string; args: Record<string, unknown> }) => {
      return `ok:${action.action}:${String(action.args.table ?? "")}`;
    });
    const recordedResults: Array<{ callId: string; observation: string; skipped: boolean }> = [];

    let requestTurn = 0;
    const result = await runAIAgentToolLoop({
      workspaceToolsEnabled: true,
      stepBudget: 2,
      requestAction: async ({ forceFinish }) => {
        requestTurn += 1;
        if (forceFinish || requestTurn > 1) {
          return {
            action: "finish",
            message: "Done",
            args: { response: "Summary ready." },
          };
        }
        // Return 3 parallel tool calls when stepBudget is 2 -> 2 run, 3rd gets budget-skipped with paired callId!
        return [
          {
            callId: "c1",
            action: parseCanonicalToolCall({
              id: "c1",
              name: "describe_table",
              arguments: { table: "users" },
            }),
          },
          {
            callId: "c2",
            action: parseCanonicalToolCall({
              id: "c2",
              name: "describe_table",
              arguments: { table: "orders" },
            }),
          },
          {
            callId: "c3",
            action: parseCanonicalToolCall({
              id: "c3",
              name: "describe_table",
              arguments: { table: "payments" },
            }),
          },
        ];
      },
      runTool,
      onToolResult: ({ callId, observation, skipped }) => {
        recordedResults.push({ callId, observation, skipped });
      },
      recoverFinish: async (reason) => ({
        action: "finish",
        message: reason,
        args: { response: "Fallback" },
      }),
    });

    expect(runTool).toHaveBeenCalledTimes(2);
    expect(recordedResults).toEqual([
      { callId: "c1", observation: "ok:describe_table:users", skipped: false },
      { callId: "c2", observation: "ok:describe_table:orders", skipped: false },
      {
        callId: "c3",
        observation:
          "Tool skipped: step or token budget reached; call finish using the evidence gathered so far.",
        skipped: true,
      },
    ]);
    expect(result.finalAction.args.response).toBe("Summary ready.");
    expect(result.steps).toHaveLength(2);
  });
});
