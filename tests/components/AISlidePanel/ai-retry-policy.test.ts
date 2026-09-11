import { describe, expect, it } from "vitest";
import {
  computeAgentRetryDelay,
  DEFAULT_AGENT_RETRY_POLICY,
} from "@/components/AISlidePanel/ai-retry-policy";
import {
  mergeRunNotes,
  canonicalizeAgentArgs,
  countTrailingToolErrors,
  isFailedToolObservation,
  isRepeatTrackedAction,
  toolErrorReflectionNudge,
  TOOL_ERROR_REFLECTION_THRESHOLD,
  type AgentTraceStep,
} from "@/components/AISlidePanel/ai-agent-context";
import type { AIWorkspaceAgentStep } from "@/components/AISlidePanel/ai-workspace-types";

describe("computeAgentRetryDelay", () => {
  const policy = DEFAULT_AGENT_RETRY_POLICY;

  it("honors a provider Retry-After that fits inside the wait cap", () => {
    const delay = computeAgentRetryDelay({
      retry: 1,
      policy,
      rateLimited: true,
      providerRetryAfterMs: 2_000,
      random: () => 0.5,
    });
    expect(delay).toBe(2_000);
  });

  it("gives up the in-line retry when the provider asks for too long", () => {
    const delay = computeAgentRetryDelay({
      retry: 1,
      policy,
      rateLimited: true,
      providerRetryAfterMs: 120_000,
      random: () => 0.5,
    });
    expect(delay).toBeNull();
  });

  it("falls back to exponential backoff with jitter without a marker", () => {
    const deterministic = computeAgentRetryDelay({
      retry: 1,
      policy: { ...policy, jitterRatio: 0 },
      rateLimited: true,
      random: () => 0.5,
    });
    expect(deterministic).toBe(policy.initialDelayMs);

    const attempt2 = computeAgentRetryDelay({
      retry: 2,
      policy: { ...policy, jitterRatio: 0 },
      rateLimited: true,
      random: () => 0.5,
    });
    expect(attempt2).toBe(1_600);
  });

  it("uses the transient base delay for non-rate-limit errors", () => {
    const delay = computeAgentRetryDelay({
      retry: 1,
      policy: { ...policy, jitterRatio: 0 },
      rateLimited: false,
      random: () => 0.5,
    });
    expect(delay).toBe(policy.initialDelayMs);
  });

  it("caps the backoff at maxDelayMs", () => {
    const delay = computeAgentRetryDelay({
      retry: 20,
      policy: { ...policy, jitterRatio: 0 },
      rateLimited: true,
      random: () => 0.5,
    });
    expect(delay).toBe(policy.maxDelayMs);
  });

  it("keeps jitter inside the promised band", () => {
    for (let index = 0; index < 50; index += 1) {
      const delay = computeAgentRetryDelay({
        retry: 1,
        policy,
        rateLimited: false,
        random: Math.random,
      });
      expect(delay).toBeGreaterThanOrEqual(policy.initialDelayMs * 0.8);
      expect(delay).toBeLessThanOrEqual(policy.initialDelayMs * 1.2);
    }
  });
});

describe("mergeRunNotes", () => {
  const runnerSteps: AIWorkspaceAgentStep[] = [
    { step: 1, action: "describe_table", message: "Inspect", observation: "TABLE=x", status: "done" },
    { step: 2, action: "run_readonly_sql", message: "Read", observation: "rows", status: "done" },
  ];
  const notes = [
    { step: 3, action: "think" as const, message: "switched provider", observation: "manual switch" },
    { step: 4, action: "think" as const, message: "chain failover", observation: "chain" },
  ];

  it("appends notes after runner steps and renumbers sequentially", () => {
    const merged = mergeRunNotes(runnerSteps, notes);
    expect(merged.map((step) => step.step)).toEqual([1, 2, 3, 4]);
    expect(merged[2].message).toBe("switched provider");
    expect(merged[3].message).toBe("chain failover");
  });

  it("keeps runner step statuses intact and marks notes done", () => {
    const errored: AIWorkspaceAgentStep[] = [
      { ...runnerSteps[0], status: "error" },
    ];
    const merged = mergeRunNotes(errored, notes);
    expect(merged[0].status).toBe("error");
    expect(merged[1].status).toBe("done");
  });

  it("returns runner steps unchanged when no notes exist", () => {
    const merged = mergeRunNotes(runnerSteps, []);
    expect(merged).toHaveLength(2);
    expect(merged.map((step) => step.step)).toEqual([1, 2]);
  });
});

describe("repeat-call helpers", () => {
  it("tracks tool actions but not meta actions", () => {
    expect(isRepeatTrackedAction("run_readonly_sql")).toBe(true);
    expect(isRepeatTrackedAction("find_value")).toBe(true);
    expect(isRepeatTrackedAction("think")).toBe(false);
    expect(isRepeatTrackedAction("finish")).toBe(false);
    expect(isRepeatTrackedAction("ask_user")).toBe(false);
  });

  it("canonicalizes args regardless of property order", () => {
    expect(canonicalizeAgentArgs({ b: 1, a: 2 })).toBe(canonicalizeAgentArgs({ a: 2, b: 1 }));
    expect(canonicalizeAgentArgs({ a: { y: 1, x: 2 } })).toBe(canonicalizeAgentArgs({ a: { x: 2, y: 1 } }));
  });
});

describe("tool-error reflection helpers", () => {
  const traceStep = (
    action: AgentTraceStep["action"],
    observation: string,
  ): AgentTraceStep => ({ step: 1, action, message: action, observation });

  it("flags Tool error / Tool blocked observations, not successful ones", () => {
    expect(isFailedToolObservation("Tool error: timeout")).toBe(true);
    expect(isFailedToolObservation("  Tool blocked: no permission")).toBe(true);
    expect(isFailedToolObservation("id | name\n1 | Ann")).toBe(false);
    expect(isFailedToolObservation("")).toBe(false);
  });

  it("counts an unbroken trailing streak of failing tool calls with different tools", () => {
    const steps: AgentTraceStep[] = [
      traceStep("list_tables", "users, orders"),
      traceStep("describe_table", "Tool error: Table \"nope\" is not present"),
      traceStep("run_readonly_sql", "Tool error: syntax error"),
      traceStep("sample_table_data", "Tool blocked: read consent denied"),
    ];
    // The repeat-call guard would miss this (three different tools); the
    // trailing-error count catches it.
    expect(countTrailingToolErrors(steps)).toBe(3);
  });

  it("treats meta steps as transparent and stops at the first success", () => {
    const withMeta: AgentTraceStep[] = [
      traceStep("run_readonly_sql", "Tool error: one"),
      traceStep("update_plan", "plan recorded"), // meta: neither counts nor resets
      traceStep("describe_table", "Tool error: two"),
    ];
    expect(countTrailingToolErrors(withMeta)).toBe(2);

    const recovered: AgentTraceStep[] = [
      traceStep("run_readonly_sql", "Tool error: one"),
      traceStep("run_readonly_sql", "id | name"), // a success ends the streak
    ];
    expect(countTrailingToolErrors(recovered)).toBe(0);
    expect(countTrailingToolErrors([])).toBe(0);
  });

  it("builds a reflection nudge that names the streak and the escape hatches", () => {
    const nudge = toolErrorReflectionNudge(TOOL_ERROR_REFLECTION_THRESHOLD);
    expect(nudge).toContain(`${TOOL_ERROR_REFLECTION_THRESHOLD} tool calls`);
    expect(nudge).toContain("re-strategize");
    expect(nudge).toContain("ask_user");
    expect(nudge).toContain("finish");
  });
});
