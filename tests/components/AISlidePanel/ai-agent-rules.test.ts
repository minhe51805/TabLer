import { describe, expect, it, vi } from "vitest";

import {
  allowedRuleVerdict,
  describeRuleLoadErrors,
  describeRuleVerdict,
  evaluateAgentRules,
  evaluateRunAgainstRules,
  foldAgentRuleVerdicts,
  formatRuleBlockMessage,
  isRuleAction,
  isRuleAllowed,
  isRunBlockedByRules,
  ruleVerdictFromEngineError,
  ruleVerdictToRequirement,
  rulesRequireApproval,
  type AgentRuleEvaluation,
  type AgentRuleMatch,
  type AgentRuleVerdict,
} from "@/components/AISlidePanel/ai-agent-rules";

function match(name: string, action: AgentRuleMatch["action"] = "block"): AgentRuleMatch {
  return { name, description: `${name} description`, action, origin: "builtin" };
}

function verdict(overrides: Partial<AgentRuleVerdict> = {}): AgentRuleVerdict {
  return {
    decision: "block",
    action: "block",
    event: "write",
    message: "DELETE has no WHERE clause.",
    matched_rules: [match("no-delete-without-where")],
    ...overrides,
  };
}

function evaluation(
  verdictValue: AgentRuleVerdict = allowedRuleVerdict("read"),
): AgentRuleEvaluation {
  return {
    verdict: verdictValue,
    report: { loaded: 1, skipped: 0, errors: [] },
  };
}

describe("agent rule verdict folding", () => {
  // A script is only as safe as its most dangerous statement, so the fold must
  // never let the order of statements decide the outcome.
  it("takes the strictest action regardless of statement order", () => {
    const warn = verdict({ decision: "warn", action: "warn", matched_rules: [match("w", "warn")] });
    const approval = verdict({
      decision: "require_approval",
      action: "require_approval",
      matched_rules: [match("a", "require_approval")],
    });
    const block = verdict();

    for (const ordered of [
      [warn, block, approval],
      [block, approval, warn],
      [approval, warn, block],
    ]) {
      const folded = foldAgentRuleVerdicts(ordered);
      expect(folded.action).toBe("block");
      expect(folded.decision).toBe("block");
    }
  });

  it("merges matched rules by name and concatenates the reasons", () => {
    const folded = foldAgentRuleVerdicts([
      verdict({ message: "first reason." }),
      verdict({
        message: "second reason.",
        matched_rules: [match("no-delete-without-where"), match("require-transaction", "warn")],
      }),
    ]);

    expect(folded.matched_rules.map((entry) => entry.name)).toEqual([
      "no-delete-without-where",
      "require-transaction",
    ]);
    expect(folded.message).toBe("first reason. second reason.");
  });

  it("promotes the run event to write when any statement wrote", () => {
    const folded = foldAgentRuleVerdicts([
      verdict({ event: "read", decision: "warn", action: "warn" }),
      verdict({ event: "write" }),
    ]);
    expect(folded.event).toBe("write");
  });

  it("returns the allowed base verdict when nothing objected", () => {
    const folded = foldAgentRuleVerdicts([allowedRuleVerdict("read")]);
    expect(isRuleAllowed(folded)).toBe(true);
    expect(folded.action).toBe("warn");
    expect(folded.matched_rules).toEqual([]);
  });
});

describe("agent rule gate predicates", () => {
  it("only a block counts as a run being blocked", () => {
    expect(isRunBlockedByRules(verdict())).toBe(true);
    expect(isRunBlockedByRules(verdict({ decision: "warn", action: "warn" }))).toBe(false);
    expect(isRunBlockedByRules(allowedRuleVerdict("read"))).toBe(false);
    // A missing verdict is not evidence of a block: callers must fail open here
    // and rely on `ruleVerdictFromEngineError` for the fail-closed write path.
    expect(isRunBlockedByRules(null)).toBe(false);
    expect(isRunBlockedByRules(undefined)).toBe(false);
  });

  it("routes require_approval to the existing dialog tier and a block to nothing", () => {
    expect(
      rulesRequireApproval(
        verdict({
          decision: "require_approval",
          action: "require_approval",
          matched_rules: [match("a", "require_approval")],
        }),
      ),
    ).toBe(true);
    expect(rulesRequireApproval(verdict())).toBe(false);

    // A `require_approval` rule rides the existing confirmation flow...
    expect(
      ruleVerdictToRequirement(
        verdict({
          decision: "require_approval",
          action: "require_approval",
          matched_rules: [match("a", "require_approval")],
        }),
      ),
    ).toBe("mutation");
    // ...while a `block` must never be softened into a dialog the user could
    // approve past, and an allowed run adds no requirement of its own.
    expect(ruleVerdictToRequirement(verdict())).toBeNull();
    expect(ruleVerdictToRequirement(allowedRuleVerdict("read"))).toBeNull();
  });

  it("recognises only the three real actions", () => {
    expect(isRuleAction("block")).toBe(true);
    expect(isRuleAction("require_approval")).toBe(true);
    expect(isRuleAction("warn")).toBe(true);
    expect(isRuleAction("BLOCK")).toBe(false);
    expect(isRuleAction(null)).toBe(false);
    expect(isRuleAction(3)).toBe(false);
  });
});

describe("agent rule messaging", () => {
  it("names every matched rule so the model can act on the reason", () => {
    const described = describeRuleVerdict(
      verdict({
        matched_rules: [match("no-delete-without-where"), match("require-transaction", "warn")],
      }),
    );
    expect(described).toContain("no-delete-without-where");
    expect(described).toContain("require-transaction");
    expect(described).toContain("DELETE has no WHERE clause.");
    expect(describeRuleVerdict(allowedRuleVerdict("read"))).toBe("");
  });

  it("hands a block back as a tool result that asks for a rewrite", () => {
    const message = formatRuleBlockMessage(verdict());
    expect(message).toContain("no-delete-without-where");
    expect(message).toContain("Rewrite");
    // The whole point of a guardrail: the model is told *why*, not just "no".
    expect(message).not.toBe("Blocked.");
  });

  it("lists load errors instead of hiding a broken guardrail", () => {
    expect(
      describeRuleLoadErrors({
        loaded: 1,
        skipped: 0,
        errors: [{ path: "C:/rules/bad.md", reason: "bad regex" }],
      }),
    ).toEqual(["C:/rules/bad.md: bad regex"]);
    expect(describeRuleLoadErrors({ loaded: 0, skipped: 0, errors: [] })).toEqual([]);
    expect(describeRuleLoadErrors(null)).toEqual([]);
    expect(describeRuleLoadErrors(undefined)).toEqual([]);
  });
});

describe("agent rule engine failure policy", () => {
  it("fails open for a read so a damaged rules dir cannot wedge a session", () => {
    const failed = ruleVerdictFromEngineError(new Error("boom"), false);
    expect(isRuleAllowed(failed)).toBe(true);
    expect(failed.event).toBe("read");
    expect(failed.matched_rules).toEqual([]);
  });

  it("escalates a write to require_approval rather than waving it through", () => {
    const failed = ruleVerdictFromEngineError(new Error("boom"), true);
    expect(isRuleAllowed(failed)).toBe(false);
    expect(failed.action).toBe("require_approval");
    expect(failed.event).toBe("write");
    expect(rulesRequireApproval(failed)).toBe(true);
    expect(failed.message).toContain("[guardrail-engine-error]");
    expect(failed.message).toContain("boom");
  });

  it("labels an engine failure distinctly from a rule match", () => {
    const failed = ruleVerdictFromEngineError("string failure", true);
    expect(failed.message).toContain("string failure");
    // It must not claim a rule fired: no rule did.
    expect(failed.matched_rules).toEqual([]);
  });
});
describe("agent rule engine calls", () => {
  /** A stand-in for the Tauri `invoke` the gate is handed at runtime. */
  function stub(result: AgentRuleEvaluation) {
    const mock = vi.fn(async (_command: string, _args?: Record<string, unknown>) => result);
    return {
      invoke: mock as unknown as Parameters<typeof evaluateAgentRules>[1],
      mock,
    };
  }

  it("evaluates one statement through Rust using explicit nulls", async () => {
    const { invoke, mock } = stub(evaluation());
    await evaluateAgentRules({ statement: "select 1" }, invoke);

    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toBe("evaluate_agent_rules");
    // Explicit nulls rather than omitted keys: the Rust command takes
    // `Option<String>` per optional field, so "absent" and "null" must not be
    // allowed to mean different things.
    expect(mock.mock.calls[0][1]).toEqual({
      workspaceDir: null,
      statement: "select 1",
      event: null,
    });
  });

  it("passes the workspace and a forced guardrail phase through", async () => {
    const { invoke, mock } = stub(evaluation());
    await evaluateAgentRules(
      { statement: "update t set a = 1", workspaceDir: "C:/ws", event: "pre_write" },
      invoke,
    );

    expect(mock.mock.calls[0][1]).toEqual({
      workspaceDir: "C:/ws",
      statement: "update t set a = 1",
      event: "pre_write",
    });
  });

  it("folds a whole run and skips blank statements", async () => {
    const { invoke, mock } = stub(evaluation(verdict()));
    const folded = await evaluateRunAgainstRules(["delete from t", "   ", ""], {
      isMutating: true,
      invoke,
    });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(folded.action).toBe("block");
  });

  it("escalates a write whose evaluation failed but fails a read open", async () => {
    const failing = (async () => {
      throw new Error("engine down");
    }) as unknown as Parameters<typeof evaluateAgentRules>[1];

    const write = await evaluateRunAgainstRules(["update t set a = 1"], {
      isMutating: true,
      invoke: failing,
    });
    expect(rulesRequireApproval(write)).toBe(true);

    const read = await evaluateRunAgainstRules(["select 1"], {
      isMutating: false,
      invoke: failing,
    });
    expect(isRuleAllowed(read)).toBe(true);
  });
});
