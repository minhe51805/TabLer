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

  it("does not let planning actions consume the step budget", async () => {
    // Mirrors the full-capability-test failure: a model that updates its plan
    // and re-lists tables repeatedly used to burn the budget before reaching
    // the late capabilities (memory, edit_tab). Planning is free while under
    // the allowance, so the real work still fits inside the same budget.
    const plan = (n: number) =>
      action("update_plan", `Plan update ${n}`, { revision: n });
    const requestAction = vi.fn()
      .mockResolvedValueOnce(action("list_tables", "Inspect tables"))
      .mockResolvedValueOnce(plan(1))
      .mockResolvedValueOnce(plan(2))
      .mockResolvedValueOnce(plan(3))
      .mockResolvedValueOnce(plan(4))
      .mockResolvedValueOnce(plan(5)) // free allowance spent → consumes budget
      .mockResolvedValueOnce(action("run_readonly_sql", "Count rows", { sql: "SELECT COUNT(*)" }))
      .mockResolvedValue(action("finish", "All capabilities covered"));
    const runTool = vi.fn().mockResolvedValue("observation");

    const result = await runAIAgentToolLoop({
      workspaceToolsEnabled: true,
      stepBudget: 2,
      requestAction,
      runTool,
      recoverFinish: vi.fn(),
    });

    expect(result.finalAction.message).toBe("All capabilities covered");
    // 4 plan updates stayed free — the readonly step only reached iteration 3
    // (list=1, plan#5=2, readonly=3), never tripping the budget guard.
    const readonlyRequest = requestAction.mock.calls
      .map(([request]) => request)
      .find((request) => request.reason === "iterate");
    expect(readonlyRequest).toBeTruthy();
    expect(requestAction.mock.calls.filter(([request]) => request.reason === "budget")).toHaveLength(0);
    // All 7 actions ran as tool steps (1 list + 5 plans + 1 readonly).
    expect(result.steps).toHaveLength(7);
  });

  it("charges planning actions against the budget once the free allowance is spent", async () => {
    // Same update_plan args repeated: after 4 free calls the 5th consumes the
    // budget, the run is unproductive (identical signature), so it closes
    // through the standard budget finish instead of planning forever.
    const requestAction = vi.fn()
      .mockImplementation(async (request: { reason: string }) =>
        request.reason === "budget"
          ? action("finish", "Wrapped up after planning loop")
          : action("update_plan", "Plan again", { revision: 1 }));
    const recoverFinish = vi.fn();

    await runAIAgentToolLoop({
      workspaceToolsEnabled: true,
      stepBudget: 1,
      requestAction,
      runTool: vi.fn().mockResolvedValue("plan recorded"),
      recoverFinish,
    });

    const iterateCalls = requestAction.mock.calls.filter(([request]) => request.reason === "iterate");
    expect(iterateCalls).toHaveLength(5); // 4 free + 1 charged
    expect(recoverFinish).not.toHaveBeenCalled();
    expect(requestAction.mock.calls.filter(([request]) => request.reason === "budget")).toHaveLength(1);
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
