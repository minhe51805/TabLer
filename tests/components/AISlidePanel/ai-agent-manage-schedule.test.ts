import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_REQUEST_REPLACED_MESSAGE } from "@/components/AISlidePanel/ai-agent-action-requestor";
import type { AIAgentToolAction } from "@/components/AISlidePanel/ai-agent-tools";
import { useQuerySchedulesStore, type QuerySchedule } from "@/stores/query-schedules-store";
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

const SCHEDULE: QuerySchedule = {
  id: "sched-1",
  name: "nightly-vacuum",
  kind: "sql",
  sql: "SELECT 1",
  connectionId: "conn-1",
  database: "appdb",
  intervalSeconds: 3600,
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const ORIGINAL_SCHEDULES_STATE = useQuerySchedulesStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useQuerySchedulesStore.setState(ORIGINAL_SCHEDULES_STATE, true);
  useQuerySchedulesStore.setState({
    schedules: [SCHEDULE],
    loadSchedules: vi.fn().mockResolvedValue(undefined),
    saveSchedule: vi.fn().mockImplementation(async (params) => ({
      ...SCHEDULE,
      id: "sched-new",
      name: params.name,
      kind: params.kind ?? "sql",
      sql: params.sql ?? "",
      prompt: params.prompt ?? null,
      database: params.database ?? null,
      intervalSeconds: params.intervalSeconds,
      enabled: params.enabled,
      allowDataRead: params.allowDataRead,
    })),
    deleteSchedule: vi.fn().mockResolvedValue(undefined),
  });
});

const tool = (args: Record<string, unknown>) =>
  ({ action: "manage_schedule", args }) as AIAgentToolAction;

describe("manage_schedule arg validation", () => {
  it("requires a valid action", async () => {
    const obs = await runTool(mkDeps(), tool({ action: "nuke" }));
    expect(obs).toContain("Tool error");
    expect(obs).toContain('"list", "create", or "delete"');
    const missing = await runTool(mkDeps(), tool({}));
    expect(missing).toContain("Tool error");
  });

  it("validates create fields before touching the store", async () => {
    const saveSchedule = useQuerySchedulesStore.getState().saveSchedule;
    const cases = [
      {
        action: "create",
        name: "",
        kind: "agent",
        prompt: "x",
        database: "appdb",
        intervalSeconds: 60,
      },
      {
        action: "create",
        name: "x",
        kind: "agent",
        prompt: "",
        database: "appdb",
        intervalSeconds: 60,
      },
      { action: "create", name: "x", kind: "sql", sql: "", database: "appdb", intervalSeconds: 60 },
      {
        action: "create",
        name: "x",
        kind: "agent",
        prompt: "p",
        database: "",
        intervalSeconds: 60,
      },
      {
        action: "create",
        name: "x",
        kind: "agent",
        prompt: "p",
        database: "appdb",
        intervalSeconds: 30,
      },
    ];
    for (const args of cases) {
      const obs = await runTool(mkDeps(), tool(args));
      expect(obs, JSON.stringify(args)).toContain("Tool error");
    }
    expect(saveSchedule).not.toHaveBeenCalled();
  });

  it("requires id or name for delete", async () => {
    const obs = await runTool(mkDeps(), tool({ action: "delete" }));
    expect(obs).toContain("Tool error");
    expect(useQuerySchedulesStore.getState().deleteSchedule).not.toHaveBeenCalled();
  });
});

describe("manage_schedule superseded-run guard", () => {
  it("throws AI_REQUEST_REPLACED before any store write", async () => {
    const deps = mkDeps({ requestId: 1, requestIdRef: { current: 2 } });
    await expect(
      runTool(
        deps,
        tool({
          action: "create",
          name: "x",
          kind: "agent",
          prompt: "p",
          database: "appdb",
          intervalSeconds: 60,
        }),
      ),
    ).rejects.toThrow(AI_REQUEST_REPLACED_MESSAGE);
    expect(useQuerySchedulesStore.getState().saveSchedule).not.toHaveBeenCalled();
    await expect(runTool(deps, tool({ action: "delete", id: "sched-1" }))).rejects.toThrow(
      AI_REQUEST_REPLACED_MESSAGE,
    );
    expect(useQuerySchedulesStore.getState().deleteSchedule).not.toHaveBeenCalled();
  });
});

describe("manage_schedule list/create/delete", () => {
  it("lists schedules from the store", async () => {
    const obs = await runTool(mkDeps(), tool({ action: "list" }));
    expect(obs).toContain("1 scheduled task(s)");
    expect(obs).toContain("nightly-vacuum");
    expect(obs).toContain("sched-1");
  });

  it("creates an agent schedule without an implicit data-read grant", async () => {
    const obs = await runTool(
      mkDeps(),
      tool({
        action: "create",
        name: "report",
        kind: "agent",
        prompt: "summarize orders",
        database: "appdb",
        intervalSeconds: 300,
      }),
    );
    expect(obs).toContain('Created agent schedule "report"');
    const saveSchedule = vi.mocked(useQuerySchedulesStore.getState().saveSchedule);
    expect(saveSchedule).toHaveBeenCalledTimes(1);
    const savedParams = saveSchedule.mock.calls[0]?.[0];
    // Agent-created schedules never ship data-read implicitly — the user opts
    // in per schedule.
    expect(savedParams?.allowDataRead).toBe(false);
    expect(savedParams?.connectionId).toBe("conn-1");
    expect(savedParams?.prompt).toBe("summarize orders");
  });

  it("deletes only the named schedule", async () => {
    const deleteSchedule = useQuerySchedulesStore.getState().deleteSchedule;
    const obs = await runTool(mkDeps(), tool({ action: "delete", name: "nightly-vacuum" }));
    expect(obs).toContain('Deleted schedule "nightly-vacuum"');
    expect(vi.mocked(deleteSchedule)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deleteSchedule)).toHaveBeenCalledWith("sched-1");
  });

  it("errors when delete matches nothing", async () => {
    const obs = await runTool(mkDeps(), tool({ action: "delete", id: "ghost" }));
    expect(obs).toContain("Tool error");
    expect(obs).toContain('id "ghost"');
    expect(useQuerySchedulesStore.getState().deleteSchedule).not.toHaveBeenCalled();
  });
});
