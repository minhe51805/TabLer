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

  it("extends a productive run past its step budget instead of forcing an early finish", async () => {
    const requestAction = vi.fn()
      .mockResolvedValueOnce(action("list_tables"))
      .mockResolvedValueOnce(action("describe_table", "Describe", { table: "users" }))
      .mockResolvedValueOnce(action("finish", "Best grounded answer"));

    const result = await runAIAgentToolLoop({
      workspaceToolsEnabled: true,
      stepBudget: 2,
      requestAction,
      runTool: vi.fn().mockResolvedValue("observation"),
      recoverFinish: vi.fn(),
    });

    expect(result.finalAction.message).toBe("Best grounded answer");
    expect(requestAction.mock.calls.map(([request]) => ({
      reason: request.reason,
      forceFinish: request.forceFinish,
      includeHistory: request.includeHistory,
      iteration: request.iteration,
    }))).toEqual([
      { reason: "iterate", forceFinish: false, includeHistory: true, iteration: 1 },
      { reason: "iterate", forceFinish: true, includeHistory: false, iteration: 2 },
      { reason: "iterate", forceFinish: false, includeHistory: false, iteration: 3 },
    ]);
  });

  it("caps extensions once the productive-run allowance is spent", async () => {
    // Every step is distinct, so every extension request is granted until the
    // MAX_STEP_EXTENSIONS allowance runs out; then the budget finish fires.
    const requestAction = vi.fn()
      .mockImplementation(async (request: { iteration: number }) => (
        request.iteration <= 10
          ? action("describe_table", `Describe ${request.iteration}`, { table: `users${request.iteration}` })
          : action("finish", "Finally grounded")
      ));

    const result = await runAIAgentToolLoop({
      workspaceToolsEnabled: true,
      stepBudget: 2,
      requestAction,
      runTool: vi.fn().mockResolvedValue("observation"),
      recoverFinish: vi.fn(),
    });

    expect(result.finalAction.message).toBe("Finally grounded");
    const reasons = requestAction.mock.calls.map(([request]) => request.reason);
    expect(reasons.filter((reason) => reason === "budget")).toHaveLength(1);
    expect(reasons[reasons.length - 1]).toBe("budget");
    // 2 base + 2 extensions × 4 = 10 tool iterations before the forced finish.
    expect(requestAction.mock.calls.filter(([request]) => request.reason === "iterate")).toHaveLength(10);
  });

  it("does not extend an unproductive run that repeats the same action", async () => {
    const requestAction = vi.fn()
      .mockResolvedValueOnce(action("list_tables"))
      .mockResolvedValueOnce(action("list_tables", "Again"))
      .mockResolvedValueOnce(action("list_tables", "Budget close-out"));
    const recoverFinish = vi.fn().mockResolvedValue(action("finish", "Recovered"));

    await runAIAgentToolLoop({
      workspaceToolsEnabled: true,
      stepBudget: 2,
      requestAction,
      runTool: vi.fn().mockResolvedValue("observation"),
      recoverFinish,
    });

    expect(recoverFinish).toHaveBeenCalledWith(
      "The agent exhausted its tool budget without returning a final answer.",
    );
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

  it("stops requesting tools once the token budget is exhausted", async () => {
    // Each request reports 5000 tokens against a 4000 budget. After the first
    // tool the run is over budget, so the tool loop ends early (no second
    // iterate) and closes through the forced budget-finish request, even
    // though the step budget still had room.
    const requestAction = vi.fn()
      .mockResolvedValueOnce(action("list_tables"))
      .mockResolvedValueOnce(action("finish", "Wrapped up on budget"));
    const runTool = vi.fn().mockResolvedValue("users, orders");

    const result = await runAIAgentToolLoop({
      workspaceToolsEnabled: true,
      stepBudget: 5,
      tokenBudget: 4000,
      getLastRequestTokens: () => 5000,
      requestAction,
      runTool,
      recoverFinish: vi.fn(),
    });

    expect(requestAction).toHaveBeenCalledTimes(2);
    expect(runTool).toHaveBeenCalledTimes(1);
    // The closing request is the forced budget finish, not another iterate.
    expect(requestAction.mock.calls[1][0]).toMatchObject({
      reason: "budget",
      forceFinish: true,
    });
    expect(result.finalAction.message).toBe("Wrapped up on budget");
    expect(result.snapshots[result.snapshots.length - 1].tokensUsed).toBe(10000);
  });

  it("ignores token accounting when no budget is configured", async () => {
    const requestAction = vi.fn()
      .mockResolvedValueOnce(action("list_tables"))
      .mockResolvedValueOnce(action("list_tables"))
      .mockResolvedValueOnce(action("finish", "Done"));

    const result = await runAIAgentToolLoop({
      workspaceToolsEnabled: true,
      stepBudget: 5,
      getLastRequestTokens: () => 999_999,
      requestAction,
      runTool: vi.fn().mockResolvedValue("obs"),
      recoverFinish: vi.fn(),
    });

    // Without tokenBudget the run continues past the huge spend and finishes
    // on its own; tokensUsed is still tracked for observability.
    expect(requestAction).toHaveBeenCalledTimes(3);
    expect(result.finalAction.message).toBe("Done");
    expect(result.snapshots[result.snapshots.length - 1].tokensUsed).toBeGreaterThan(0);
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
