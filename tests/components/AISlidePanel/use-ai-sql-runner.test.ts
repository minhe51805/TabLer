import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requestAISqlConfirmationMock = vi.fn();
const invokeWithTimeoutMock = vi.fn();
const invokeMutationMock = vi.fn();
vi.mock("@/utils/tauri-utils", () => ({
  invokeWithTimeout: (...args: unknown[]) => invokeWithTimeoutMock(...args),
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
}));
vi.mock("@/components/AISlidePanel/ai-sql-confirm", () => ({
  requestAISqlConfirmation: (...args: unknown[]) => requestAISqlConfirmationMock(...args),
}));

import { useAISqlRunner } from "@/components/AISlidePanel/hooks/use-ai-sql-runner";
import { useConnectionStore } from "@/stores/connectionStore";

const queryResult = {
  columns: [],
  rows: [],
  affected_rows: 0,
  execution_time_ms: 1,
  query: "q",
  sandboxed: true,
  truncated: false,
};

function setupRunner() {
  const executeSandboxQuery = vi.fn().mockResolvedValue(queryResult);
  const setError = vi.fn();
  const switchDatabase = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() =>
    useAISqlRunner({ connectionId: "conn-1", executeSandboxQuery, setError, switchDatabase }),
  );
  return { result, executeSandboxQuery, setError };
}

/** The rules engine's answer, shaped exactly as `agent_rules.rs` serialises it. */
function ruleEvaluation(
  action: "warn" | "require_approval" | "block" = "warn",
  overrides: { message?: string; matched?: Array<{ name: string; description: string }> } = {},
) {
  const decision = action === "warn" ? "allow" : action;
  const matched = (
    overrides.matched ??
    (action === "warn" ? [] : [{ name: "probe-rule", description: "probe rule" }])
  ).map((rule) => ({ ...rule, action, origin: "builtin" }));
  return {
    verdict: {
      decision,
      action,
      event: "write",
      message: overrides.message ?? (action === "warn" ? "" : "[probe-rule] probe rule"),
      matched_rules: matched,
    },
    report: { loaded: 0, skipped: 0, errors: [] },
  };
}

/**
 * The guardrail engine must be answered explicitly: an unmocked `invoke` rejects,
 * and a *failed* evaluation of a write deliberately escalates to
 * `require_approval`, so every write here would ask for a dialog the test never
 * approves. "Allow" is therefore the default, and each rule test overrides it.
 */
function resetRuleEngine() {
  invokeMutationMock.mockReset();
  invokeMutationMock.mockResolvedValue(ruleEvaluation("warn"));
}

describe("useAISqlRunner Safe Mode pre-approval", () => {
  beforeEach(() => {
    requestAISqlConfirmationMock.mockReset();
    resetRuleEngine();
    invokeWithTimeoutMock.mockReset();
    invokeWithTimeoutMock.mockResolvedValue({ fileName: "ck.sql", tables: 2, rows: 5 });
    useConnectionStore.setState({ currentDatabase: "app" });
  });

  it("does NOT claim pre-approval for read-classified runs (no dialog shown)", async () => {
    // Frontend regex classifies this as a read → requirement null → the real
    // requestAISqlConfirmation short-circuits true without showing a dialog.
    // The backend's stricter parser must stay fail-closed (e.g. mutating
    // CTEs), so the approval flag has to stay false.
    requestAISqlConfirmationMock.mockResolvedValue(true);
    const { result, executeSandboxQuery } = setupRunner();
    await act(async () => {
      await result.current.runSql("SELECT * FROM users");
    });
    expect(requestAISqlConfirmationMock).not.toHaveBeenCalled();
    expect(executeSandboxQuery).toHaveBeenCalledWith("conn-1", ["SELECT * FROM users"], undefined, {
      preApproved: false,
    });
  });

  it("claims pre-approval after the review dialog approves a mutation", async () => {
    requestAISqlConfirmationMock.mockResolvedValue(true);
    const { result, executeSandboxQuery } = setupRunner();
    await act(async () => {
      await result.current.runSql("UPDATE users SET x = 1");
    });
    expect(requestAISqlConfirmationMock).toHaveBeenCalledWith("high-risk", [
      "UPDATE users SET x = 1",
    ]);
    expect(executeSandboxQuery).toHaveBeenCalledWith(
      "conn-1",
      ["UPDATE users SET x = 1"],
      undefined,
      { preApproved: true },
    );
  });

  it("full autonomy pre-approves without showing any dialog", async () => {
    // Requirement is null (full autonomy replaces the per-run dialog), and
    // the run still carries the standing-approval flag for Safe Mode.
    const { result, executeSandboxQuery } = setupRunner();
    await act(async () => {
      await result.current.runSql("UPDATE users SET x = 1", { agentAutonomy: "full" });
    });
    expect(requestAISqlConfirmationMock).not.toHaveBeenCalled();
    expect(executeSandboxQuery).toHaveBeenCalledWith(
      "conn-1",
      ["UPDATE users SET x = 1"],
      undefined,
      { preApproved: true },
    );
  });

  it("a denied review dialog cancels the run before touching the sandbox", async () => {
    requestAISqlConfirmationMock.mockResolvedValue(false);
    const { result, executeSandboxQuery, setError } = setupRunner();
    await expect(
      act(async () => {
        await result.current.runSql("UPDATE users SET x = 1");
      }),
    ).rejects.toThrow("Execution cancelled.");
    expect(executeSandboxQuery).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith("Execution cancelled.");
  });
});

describe("useAISqlRunner auto-checkpoint safety net", () => {
  beforeEach(() => {
    requestAISqlConfirmationMock.mockReset();
    resetRuleEngine();
    invokeWithTimeoutMock.mockReset();
    invokeWithTimeoutMock.mockResolvedValue({ fileName: "ck.sql", tables: 2, rows: 5 });
    useConnectionStore.setState({
      connections: [{ id: "conn-1", db_type: "mssql" }] as never,
      currentDatabase: "app",
    });
  });

  it("P1 regression: full autonomy + UPDATE still snapshots a checkpoint first", async () => {
    const { result, executeSandboxQuery } = setupRunner();
    await act(async () => {
      await result.current.runSql("UPDATE users SET x = 1", { agentAutonomy: "full" });
    });
    expect(invokeWithTimeoutMock).toHaveBeenCalledWith(
      "create_database_checkpoint",
      expect.objectContaining({ connectionId: "conn-1", label: "auto-before-agent-write" }),
      60_000,
      "Safety checkpoint",
    );
    expect(executeSandboxQuery).toHaveBeenCalledWith(
      "conn-1",
      ["UPDATE users SET x = 1"],
      undefined,
      { preApproved: true },
    );
  });

  it("skips the checkpoint for read-classified runs", async () => {
    const { result } = setupRunner();
    await act(async () => {
      await result.current.runSql("SELECT * FROM users", { agentAutonomy: "full" });
    });
    expect(invokeWithTimeoutMock).not.toHaveBeenCalled();
  });

  describe("useAISqlRunner guardrail rules", () => {
    beforeEach(() => {
      requestAISqlConfirmationMock.mockReset();
      resetRuleEngine();
      invokeWithTimeoutMock.mockReset();
      invokeWithTimeoutMock.mockResolvedValue({ fileName: "ck.sql", tables: 2, rows: 5 });
      useConnectionStore.setState({
        connections: [{ id: "conn-1", db_type: "mssql" }] as never,
        currentDatabase: "app",
      });
    });

    it("refuses a run a `block` rule objected to, without executing anything", async () => {
      invokeMutationMock.mockResolvedValue(
        ruleEvaluation("block", { message: "[no-delete-without-where] DELETE has no WHERE." }),
      );
      const { result, executeSandboxQuery, setError } = setupRunner();

      await act(async () => {
        await expect(result.current.runSql("DELETE FROM users")).rejects.toThrow(
          /Blocked by a guardrail rule/,
        );
      });

      expect(executeSandboxQuery).not.toHaveBeenCalled();
      // A block is not a dialog: asking the user to approve past it would make the
      // rule advisory, which is not what `block` means.
      expect(requestAISqlConfirmationMock).not.toHaveBeenCalled();
      expect(setError).toHaveBeenCalledWith(expect.stringContaining("no-delete-without-where"));
    });

    it("forces the dialog for a `require_approval` rule even under full autonomy", async () => {
      invokeMutationMock.mockResolvedValue(ruleEvaluation("require_approval"));
      requestAISqlConfirmationMock.mockResolvedValue(true);
      const { result, executeSandboxQuery } = setupRunner();

      await act(async () => {
        await result.current.runSql("DROP TABLE audit_log", { agentAutonomy: "full" });
      });

      // Full autonomy pre-approves autonomy in general, not the specific statement
      // a rule was written to catch — so the human is still asked.
      expect(requestAISqlConfirmationMock).toHaveBeenCalledTimes(1);
      expect(executeSandboxQuery).toHaveBeenCalledTimes(1);
    });

    it("honours a denial of the rule-forced dialog", async () => {
      invokeMutationMock.mockResolvedValue(ruleEvaluation("require_approval"));
      requestAISqlConfirmationMock.mockResolvedValue(false);
      const { result, executeSandboxQuery } = setupRunner();

      await act(async () => {
        await expect(
          result.current.runSql("DROP TABLE audit_log", { agentAutonomy: "full" }),
        ).rejects.toThrow("Execution cancelled.");
      });

      expect(executeSandboxQuery).not.toHaveBeenCalled();
    });

    it("does not force a dialog for a `warn`-only run", async () => {
      invokeMutationMock.mockResolvedValue(
        ruleEvaluation("warn", {
          matched: [{ name: "no-lock-hints-on-write", description: "lock hint on a write" }],
        }),
      );
      const { result, executeSandboxQuery } = setupRunner();

      await act(async () => {
        await result.current.runSql("SELECT * FROM users", { agentAutonomy: "full" });
      });

      expect(requestAISqlConfirmationMock).not.toHaveBeenCalled();
      expect(executeSandboxQuery).toHaveBeenCalledTimes(1);
    });
  });
});
