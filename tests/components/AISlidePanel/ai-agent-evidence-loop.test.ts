import { describe, expect, it, vi } from "vitest";
import { runAgentEvidenceLoop } from "@/components/AISlidePanel/ai-agent-evidence-loop";
import type { AIAgentFinishAction } from "@/components/AISlidePanel/ai-agent-tools";

const shared = "SHARED";
function finish(response = "answer", withSql?: string): AIAgentFinishAction {
  const args: Record<string, unknown> = { response };
  if (withSql !== undefined) args.sql = withSql;
  return { action: "finish", message: "done", args } as unknown as AIAgentFinishAction;
}
function toolAction(action = "run_readonly_sql") {
  return { action, message: "running" };
}

const okVerify = { ok: true, unsupported: [] };

vi.mock("@/components/AISlidePanel/ai-agent-verification", () => ({
  verifyAgentResponseAgainstEvidence: vi.fn(() => okVerify),
}));

async function runLoop(overrides: Record<string, unknown> = {}) {
  const base = {
    workspaceToolsEnabled: true,
    endedWithAskUser: false,
    assistIntent: "sql" as never,
    wantsReportTable: false,
    sharedAgentInstruction: shared,
    requestAgentAction: vi.fn().mockResolvedValue(finish("final", "SELECT 1")),
    runAgentTool: vi.fn().mockResolvedValue("rows"),
    publishAgentProgress: vi.fn(),
    recoverAgentFinishAction: vi.fn().mockResolvedValue(finish("recovered")),
    buildControllerPrompt: vi.fn((force: boolean, extra?: string) => `prompt:${force}:${extra ?? ""}`),
    isSupersededAIRequestError: (e: unknown) =>
      e instanceof Error && e.message === "superseded",
  };
  return runLoopWith({ ...base, ...overrides });
}

// small helper to satisfy typing while keeping overrides simple
function runLoopWith(params: Record<string, unknown>) {
  return runAgentEvidenceLoop(params as Parameters<typeof runAgentEvidenceLoop>[0]);
}

describe("runAgentEvidenceLoop", () => {
  it("returns immediately when workspace tools are disabled", async () => {
    const requestAgentAction = vi.fn();
    const result = await runLoop({
      workspaceToolsEnabled: false,
      initialFinalAction: undefined,
      initialAction: finish("a"),
      initialSteps: [],
      requestAgentAction,
    });
    expect(requestAgentAction).not.toHaveBeenCalled();
    expect(result.finalAction.args?.response).toBe("a");
  });

  it("keeps a complete finish (sql + read evidence) without any retry", async () => {
    const requestAgentAction = vi.fn();
    const steps = [{ step: 1, action: "run_readonly_sql", message: "", observation: "id" }];
    const result = await runLoop({
      initialAction: finish("ok", "SELECT 1"),
      initialSteps: steps,
      requestAgentAction,
    });
    expect(requestAgentAction).not.toHaveBeenCalled();
    expect(result.finalSteps).toHaveLength(1);
  });

  it("runs one recovery round when finish lacks SQL, then closes the loop", async () => {
    const calls: string[] = [];
    const requestAgentAction = vi
      .fn()
      .mockImplementationOnce(async (prompt: string) => {
        calls.push(prompt);
        return toolAction();
      })
      .mockImplementationOnce(async (prompt: string) => {
        calls.push(prompt);
        return finish("with sql", "SELECT 1");
      });
    const runAgentTool = vi.fn().mockResolvedValue("data rows");

    const result = await runLoop({
      initialAction: finish("no data yet"),
      initialSteps: [],
      requestAgentAction,
      runAgentTool,
    });

    expect(calls).toHaveLength(2);
    expect(runAgentTool).toHaveBeenCalledTimes(1);
    expect(result.finalAction.args?.response).toBe("with sql");
    expect(result.finalSteps).toHaveLength(1); // empty initial trace + recovered observation
  });

  it("breaks out of the loop when a superseded error occurs mid-recovery", async () => {
    const superseded = new Error("superseded");
    const requestAgentAction = vi.fn()
      .mockResolvedValueOnce(toolAction())
      .mockRejectedValueOnce(superseded);
    await expect(
      runLoop({
        initialAction: finish("nope"),
        initialSteps: [],
        requestAgentAction,
        isSupersededAIRequestError: (e: unknown) => e === superseded,
      }),
    ).rejects.toBe(superseded);
  });

  it("falls back to the current finish when recovery errors non-superseded", async () => {
    const requestAgentAction = vi.fn()
      .mockResolvedValueOnce(toolAction())
      .mockRejectedValueOnce(new Error("provider down"));
    const result = await runLoop({
      initialAction: finish("best effort"),
      initialSteps: [],
      requestAgentAction,
    });
    expect(result.finalAction.args?.response).toBe("best effort");
  });
});
