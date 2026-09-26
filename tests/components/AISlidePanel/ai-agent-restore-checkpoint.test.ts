import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentToolAvailability } from "@/components/AISlidePanel/ai-agent-engine-gates";
import { createAgentToolExecutor } from "@/components/AISlidePanel/ai-agent-tool-executor";
import type { AIAgentToolAction } from "@/components/AISlidePanel/ai-agent-tools";
import { invalidateAgentSchemaSummary } from "@/components/AISlidePanel/ai-schema-summary";
import { mkDeps, runTool } from "./ai-agent-test-harness";

vi.mock("@/utils/semantic-glossary", () => ({
  saveSemanticGlossaryEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: vi.fn(),
}));
vi.mock("@/components/AISlidePanel/hooks/use-agent-memory", () => ({
  invalidateAgentMemoryIndex: vi.fn(),
  getAgentMemoryIndex: vi.fn(),
}));
vi.mock("@/components/AISlidePanel/ai-schema-summary", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, invalidateAgentSchemaSummary: vi.fn() };
});

const pickMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/AISlidePanel/ai-checkpoint-picker", () => ({
  requestAICheckpointPick: pickMock,
}));

const CHECKPOINTS = [
  {
    fileName: "cp-2.backup",
    label: "agent-pre-write",
    createdAt: 200,
    engine: "postgresql",
    database: "appdb",
    tableCount: 3,
    rowCount: 640,
    sizeBytes: 4096,
  },
];

function restoreDeps(pickResult: string | null = "cp-2.backup") {
  pickMock.mockResolvedValue(pickResult);
  return mkDeps({
    dbType: "postgresql",
    listCheckpoints: vi.fn().mockResolvedValue(CHECKPOINTS),
    restoreCheckpoint: vi.fn().mockResolvedValue(undefined),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("restore_checkpoint", () => {
  it("fails closed when the engine cannot replay a checkpoint", async () => {
    const deps = restoreDeps();
    deps.toolAvailability = agentToolAvailability("opensearch");
    const obs = await runTool(deps, { action: "restore_checkpoint", args: {} });
    expect(obs).toContain("Tool blocked");
    expect(obs).toContain("restore_checkpoint is not available on OpenSearch");
    // Fail closed = nothing reached the backend or the picker.
    expect(deps.listCheckpoints).not.toHaveBeenCalled();
    expect(deps.restoreCheckpoint).not.toHaveBeenCalled();
    expect(pickMock).not.toHaveBeenCalled();
  });
  it("runs at most one rollback per run", async () => {
    const deps = restoreDeps();
    const executor = createAgentToolExecutor(deps);

    const first = await executor.runAgentTool({
      action: "restore_checkpoint",
      message: "rollback",
      args: { label_hint: "pre-write" },
    });
    expect(first).toContain('Database restored to checkpoint "agent-pre-write"');
    expect(deps.restoreCheckpoint).toHaveBeenCalledTimes(1);

    // A different label_hint sidesteps the identical-call de-dup so the
    // per-run budget itself is what refuses the second rollback.
    const second = await executor.runAgentTool({
      action: "restore_checkpoint",
      message: "rollback",
      args: { label_hint: "other" },
    });
    expect(second).toContain("budget exhausted for this run");
    expect(deps.restoreCheckpoint).toHaveBeenCalledTimes(1);
    expect(pickMock).toHaveBeenCalledTimes(1);
  });

  it("picker cancellation performs no restore", async () => {
    const deps = restoreDeps(null);
    const obs = await runTool(deps, { action: "restore_checkpoint", args: {} });
    expect(obs).toContain("User cancelled the rollback");
    expect(deps.restoreCheckpoint).not.toHaveBeenCalled();
  });

  it("a successful restore clears the per-run read cache and invalidates the schema summary", async () => {
    const deps = restoreDeps();
    const executor = createAgentToolExecutor(deps);

    // run_readonly_sql is exempt from the identical-call de-dup, so a repeat
    // lands on the per-run result cache.
    const action = {
      action: "run_readonly_sql",
      args: { sql: "SELECT 1" },
    } as AIAgentToolAction;
    // An unbounded SELECT also triggers an EXPLAIN preflight — count only the
    // calls carrying the real statement.
    const selectCalls = () =>
      vi.mocked(deps.executeReadonlyQuery).mock.calls.filter((call) => call[1]?.[0] === "SELECT 1")
        .length;
    await executor.runAgentTool(action);
    const cached = await executor.runAgentTool(action);
    expect(cached).toContain("[cached — identical run_readonly_sql call already ran in this run]");
    expect(selectCalls()).toBe(1);

    await executor.runAgentTool({ action: "restore_checkpoint", message: "rollback", args: {} });
    expect(vi.mocked(invalidateAgentSchemaSummary)).toHaveBeenCalledWith("conn-1");

    // The same read must hit the backend again — a stale catalog after a
    // rollback would feed the agent the pre-restore data.
    const after = await executor.runAgentTool(action);
    expect(after).not.toContain("[cached");
    expect(selectCalls()).toBe(2);
  });
});
