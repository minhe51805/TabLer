import { describe, expect, it, vi } from "vitest";
import {
  runAIAgentToolLoop,
  type AIAgentRunnerSnapshot,
} from "@/components/AISlidePanel/ai-agent-runner";
import type { AIAgentToolAction } from "@/components/AISlidePanel/ai-agent-tools";

function action(
  actionName: AIAgentToolAction["action"],
  message: string = actionName,
  args: Record<string, unknown> = {},
): AIAgentToolAction {
  return { action: actionName, message, args } as AIAgentToolAction;
}

describe("AI agent tool runner", () => {
  it("requests one direct finish when workspace tools are unavailable", async () => {
    const requestAction = vi.fn().mockResolvedValue(action("finish", "Done"));
    const runTool = vi.fn();
    const recoverFinish = vi.fn();

    const result = await runAIAgentToolLoop({
      workspaceToolsEnabled: false,
      stepBudget: 4,
      requestAction,
      runTool,
      recoverFinish,
    });

    expect(result.finalAction).toEqual(action("finish", "Done"));
    expect(requestAction).toHaveBeenCalledWith(expect.objectContaining({
      forceFinish: true,
      includeHistory: true,
      iteration: 0,
      reason: "direct",
    }));
    expect(runTool).not.toHaveBeenCalled();
    expect(recoverFinish).not.toHaveBeenCalled();
    expect(result.snapshots.map((snapshot) => snapshot.phase)).toEqual([
      "idle",
      "requesting-action",
      "finished",
    ]);
  });

  it("records each tool observation before requesting the next action", async () => {
    const requestAction = vi.fn()
      .mockResolvedValueOnce(action("list_tables", "Inspect tables"))
      .mockResolvedValueOnce(action("finish", "Ready"));
    const runTool = vi.fn().mockResolvedValue("users, orders");

    const result = await runAIAgentToolLoop({
      workspaceToolsEnabled: true,
      stepBudget: 3,
      initialSteps: [{
        step: 1,
        action: "plan",
        message: "First inspect the workspace.",
        observation: "",
      }],
      requestAction,
      runTool,
      recoverFinish: vi.fn(),
    });

    expect(runTool).toHaveBeenCalledWith(action("list_tables", "Inspect tables"));
    expect(result.steps).toEqual([
      {
        step: 1,
        action: "plan",
        message: "First inspect the workspace.",
        observation: "",
      },
      {
        step: 2,
        action: "list_tables",
        message: "Inspect tables",
        observation: "users, orders",
      },
    ]);
    expect(requestAction.mock.calls[1][0].steps).toHaveLength(2);
    expect(result.snapshots.map((snapshot) => snapshot.phase)).toEqual([
      "idle",
      "requesting-action",
      "running-tool",
      "tool-completed",
      "requesting-action",
      "finished",
    ]);
  });

  it("uses a final budget request after all tool iterations are consumed", async () => {
    const requestAction = vi.fn()
      .mockResolvedValueOnce(action("list_tables"))
      .mockResolvedValueOnce(action("describe_table", "Describe", { table: "users" }))
      .mockResolvedValueOnce(action("finish", "Best grounded answer"));

    await runAIAgentToolLoop({
      workspaceToolsEnabled: true,
      stepBudget: 2,
      requestAction,
      runTool: vi.fn().mockResolvedValue("observation"),
      recoverFinish: vi.fn(),
    });

    expect(requestAction.mock.calls.map(([request]) => ({
      reason: request.reason,
      forceFinish: request.forceFinish,
      includeHistory: request.includeHistory,
      iteration: request.iteration,
    }))).toEqual([
      { reason: "iterate", forceFinish: false, includeHistory: true, iteration: 1 },
      { reason: "iterate", forceFinish: true, includeHistory: false, iteration: 2 },
      { reason: "budget", forceFinish: true, includeHistory: false, iteration: 3 },
    ]);
  });

  it("recovers when the budget request still returns a tool action", async () => {
    const requestAction = vi.fn()
      .mockResolvedValueOnce(action("list_tables"))
      .mockResolvedValueOnce(action("run_readonly_sql", "Still querying", { sql: "SELECT 1" }));
    const recoverFinish = vi.fn().mockResolvedValue(action("finish", "Recovered"));

    const result = await runAIAgentToolLoop({
      workspaceToolsEnabled: true,
      stepBudget: 1,
      requestAction,
      runTool: vi.fn().mockResolvedValue("users"),
      recoverFinish,
    });

    expect(result.finalAction.message).toBe("Recovered");
    expect(recoverFinish).toHaveBeenCalledWith(
      "The agent exhausted its tool budget without returning a final answer.",
    );
    expect(result.snapshots.map((snapshot) => snapshot.phase)).toContain("recovering-finish");
  });

  it("keeps emitted trace snapshots independent from later transitions", async () => {
    const snapshots: AIAgentRunnerSnapshot[] = [];
    const requestAction = vi.fn()
      .mockResolvedValueOnce(action("list_tables"))
      .mockResolvedValueOnce(action("finish"));

    await runAIAgentToolLoop({
      workspaceToolsEnabled: true,
      stepBudget: 2,
      requestAction,
      runTool: vi.fn().mockResolvedValue("users"),
      recoverFinish: vi.fn(),
      onStateChange: (snapshot) => snapshots.push(snapshot),
    });

    expect(snapshots[0].steps).toEqual([]);
    expect(snapshots.find((snapshot) => snapshot.phase === "running-tool")?.steps).toEqual([]);
    expect(snapshots.find((snapshot) => snapshot.phase === "tool-completed")?.steps).toHaveLength(1);
  });

  it("emits a failed state and preserves the original error", async () => {
    const snapshots: AIAgentRunnerSnapshot[] = [];
    const failure = new Error("provider unavailable");

    await expect(runAIAgentToolLoop({
      workspaceToolsEnabled: false,
      stepBudget: 1,
      requestAction: vi.fn().mockRejectedValue(failure),
      runTool: vi.fn(),
      recoverFinish: vi.fn(),
      onStateChange: (snapshot) => snapshots.push(snapshot),
    })).rejects.toBe(failure);

    expect(snapshots[snapshots.length - 1]).toEqual(expect.objectContaining({
      phase: "failed",
      error: "provider unavailable",
    }));
  });
});
