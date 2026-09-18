import { beforeEach, describe, expect, it, vi } from "vitest";

type FiredPayload = Record<string, unknown>;
type FiredHandler = (event: { payload: FiredPayload }) => void;

const listenMock = vi.fn(async (_eventName: string, _handler: FiredHandler) => () => {});
const invokeMutationMock = vi.fn();
const emitAppToastMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (eventName: string, handler: FiredHandler) => listenMock(eventName, handler),
}));
vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
}));
vi.mock("@/utils/app-toast", () => ({
  emitAppToast: (...args: unknown[]) => emitAppToastMock(...args),
}));

import { useAgentScheduleStore } from "@/stores/agent-schedule-store";
import { useQuerySchedulesStore, type QuerySchedule } from "@/stores/query-schedules-store";

function agentSchedule(overrides: Partial<QuerySchedule> = {}): QuerySchedule {
  return {
    id: "s1",
    name: "Nightly order check",
    kind: "agent",
    sql: "",
    prompt: "Find orders stuck in pending for more than 24 hours.",
    connectionId: "conn-a",
    database: "shop",
    intervalSeconds: 900,
    enabled: true,
    lastRanAt: null,
    lastStatus: null,
    lastRows: null,
    lastError: null,
    lastSummary: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The `schedule-fired` handler the store registered, so tests can fire events. */
function scheduleFiredHandler(): FiredHandler {
  const call = listenMock.mock.calls.find(([eventName]) => eventName === "schedule-fired");
  if (!call) throw new Error("schedule-fired listener was never registered");
  return call[1];
}

describe("query-schedules-store agent dispatch", () => {
  beforeEach(() => {
    // The listener is registered once per module instance and stays registered;
    // resetting the mock would hide the handler these tests fire.
    emitAppToastMock.mockReset();
    invokeMutationMock.mockReset();
    useAgentScheduleStore.setState({ runs: [] });
    useQuerySchedulesStore.setState({ schedules: [agentSchedule()], isLoading: false });
    useQuerySchedulesStore.getState().attachScheduleEvents();
  });

  it("queues an agent dispatch instead of claiming a run", () => {
    scheduleFiredHandler()({
      payload: {
        scheduleId: "s1",
        name: "Nightly order check",
        kind: "agent",
        status: "dispatched",
        prompt: "  Find stuck orders.  ",
        connectionId: "conn-a",
        database: "shop",
      },
    });

    const [row] = useQuerySchedulesStore.getState().schedules;
    expect(row.lastStatus).toBe("dispatched");
    expect(row.lastRows).toBeNull();

    const [task] = useAgentScheduleStore.getState().runs;
    expect(task).toMatchObject({
      scheduleId: "s1",
      prompt: "Find stuck orders.",
      status: "waiting",
      connectionId: "conn-a",
      database: "shop",
    });
    expect(emitAppToastMock).toHaveBeenCalledWith(expect.objectContaining({ tone: "info" }));
  });

  it("clears the previous run's report when a new dispatch arrives", () => {
    useQuerySchedulesStore.setState({
      schedules: [
        agentSchedule({ lastStatus: "ok", lastSummary: "Yesterday's report", lastError: "stale" }),
      ],
    });

    scheduleFiredHandler()({
      payload: {
        scheduleId: "s1",
        name: "Nightly order check",
        kind: "agent",
        prompt: "Look again.",
      },
    });

    const [row] = useQuerySchedulesStore.getState().schedules;
    expect(row.lastSummary).toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.lastStatus).toBe("dispatched");
  });

  it("treats a dispatch without a kind as a hand-off too", () => {
    scheduleFiredHandler()({
      payload: {
        scheduleId: "s1",
        name: "Nightly order check",
        status: "dispatched",
        prompt: "Legacy payload with no kind.",
      },
    });
    expect(useAgentScheduleStore.getState().runs).toHaveLength(1);
  });

  it("does not queue a dispatch that carries no task text", () => {
    scheduleFiredHandler()({
      payload: { scheduleId: "s1", name: "Nightly order check", kind: "agent", prompt: "   " },
    });
    expect(useAgentScheduleStore.getState().runs).toEqual([]);
    expect(emitAppToastMock).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });

  it("leaves a SQL run on the backend outcome path", () => {
    useQuerySchedulesStore.setState({
      schedules: [agentSchedule({ kind: "sql", sql: "SELECT 1", prompt: null })],
    });

    scheduleFiredHandler()({
      payload: { scheduleId: "s1", name: "Hourly count", kind: "sql", status: "ok", rows: 3 },
    });

    const [row] = useQuerySchedulesStore.getState().schedules;
    expect(row.lastStatus).toBe("ok");
    expect(row.lastRows).toBe(3);
    expect(useAgentScheduleStore.getState().runs).toEqual([]);
  });
});

describe("query-schedules-store agent task persistence", () => {
  beforeEach(() => {
    invokeMutationMock.mockReset();
    useAgentScheduleStore.setState({ runs: [] });
    useQuerySchedulesStore.setState({ schedules: [agentSchedule()], isLoading: false });
  });

  it("sends the kind and prompt of an agent task to the backend", async () => {
    invokeMutationMock.mockResolvedValueOnce(
      agentSchedule({ id: "s2", name: "Weekly audit", prompt: "Audit orphan rows." }),
    );

    await useQuerySchedulesStore.getState().saveSchedule({
      name: "Weekly audit",
      kind: "agent",
      sql: "",
      prompt: "Audit orphan rows.",
      connectionId: "conn-a",
      database: null,
      intervalSeconds: 600,
      enabled: true,
    });

    expect(invokeMutationMock).toHaveBeenCalledWith(
      "save_query_schedule",
      expect.objectContaining({
        kind: "agent",
        prompt: "Audit orphan rows.",
        sql: "",
        intervalSeconds: 600,
      }),
    );
  });

  it("defaults every existing caller to a SQL schedule", async () => {
    invokeMutationMock.mockResolvedValueOnce(agentSchedule({ kind: "sql" }));

    await useQuerySchedulesStore.getState().saveSchedule({
      name: "Hourly count",
      sql: "SELECT 1",
      connectionId: "conn-a",
      intervalSeconds: 30,
      enabled: true,
    });

    // The interval is floored at the scheduler's minimum; `kind` is never absent.
    expect(invokeMutationMock).toHaveBeenCalledWith(
      "save_query_schedule",
      expect.objectContaining({ kind: "sql", prompt: null, intervalSeconds: 60 }),
    );
  });

  it("mirrors a reported run outcome into the cached row", () => {
    useSchedulesWithRow();
    useQuerySchedulesStore.getState().applyAgentRunOutcome({
      scheduleId: "s1",
      status: "ok",
      rows: null,
      error: null,
      summary: "Found 3 stuck orders.",
    });

    const [row] = useQuerySchedulesStore.getState().schedules;
    expect(row.lastStatus).toBe("ok");
    expect(row.lastSummary).toBe("Found 3 stuck orders.");
    expect(row.lastError).toBeNull();
    expect(row.lastRanAt).toBeGreaterThan(0);
  });

  it("keeps a run that stopped short out of the ok column", () => {
    useQuerySchedulesStore.getState().applyAgentRunOutcome({
      scheduleId: "s1",
      status: "needs_human",
      rows: null,
      error: null,
      summary: "[read-only] refused 1 blocked tool call(s): ask_user",
    });

    const [row] = useQuerySchedulesStore.getState().schedules;
    expect(row.lastStatus).toBe("needs_human");
    expect(row.lastError).toBeNull();
    expect(row.lastSummary).toContain("ask_user");
  });

  it("drops a queued task when its schedule is deleted", async () => {
    invokeMutationMock.mockResolvedValueOnce(undefined);
    useAgentScheduleStore.getState().enqueueAgentTask({
      scheduleId: "s1",
      name: "Nightly order check",
      prompt: "Look for stuck orders.",
    });

    await useQuerySchedulesStore.getState().deleteSchedule("s1");

    expect(invokeMutationMock).toHaveBeenCalledWith("delete_query_schedule", { id: "s1" });
    expect(useQuerySchedulesStore.getState().schedules).toEqual([]);
    // Work whose row no longer exists cannot report back, so it must not run.
    expect(useAgentScheduleStore.getState().runs).toEqual([]);
  });
});

function useSchedulesWithRow() {
  useQuerySchedulesStore.setState({ schedules: [agentSchedule()] });
}
