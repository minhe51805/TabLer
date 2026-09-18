import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMutationMock = vi.fn();

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
}));

import { describeTaskWait, useAgentScheduleStore } from "@/stores/agent-schedule-store";

const CONTEXT = { connectionId: "conn-a", database: "shop", isBusy: false };

type EnqueueParams = Parameters<
  ReturnType<typeof useAgentScheduleStore.getState>["enqueueAgentTask"]
>[0];

function enqueueTask(overrides: Partial<EnqueueParams> = {}) {
  useAgentScheduleStore.getState().enqueueAgentTask({
    scheduleId: "s1",
    name: "Nightly order check",
    prompt: "Find orders stuck in pending for more than 24 hours.",
    connectionId: "conn-a",
    database: "shop",
    ...overrides,
  });
}

describe("agent-schedule-store", () => {
  beforeEach(() => {
    invokeMutationMock.mockReset();
    useAgentScheduleStore.setState({ runs: [] });
  });

  it("queues a dispatched task as waiting, with its scope", () => {
    enqueueTask();
    const [task] = useAgentScheduleStore.getState().runs;
    expect(task).toMatchObject({
      scheduleId: "s1",
      status: "waiting",
      connectionId: "conn-a",
      database: "shop",
    });
    expect(task.dispatchedAt).toBeGreaterThan(0);
  });

  it("replaces a still-waiting dispatch instead of queueing the same task twice", () => {
    enqueueTask();
    enqueueTask({ prompt: "Second dispatch, newer prompt." });
    const runs = useAgentScheduleStore.getState().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0].prompt).toBe("Second dispatch, newer prompt.");
  });

  it("refuses to re-dispatch a task that is already running", () => {
    enqueueTask();
    const claimed = useAgentScheduleStore.getState().claimRunnableTask(CONTEXT);
    expect(claimed?.status).toBe("running");

    enqueueTask({ prompt: "A duplicate dispatch the app cannot answer." });
    const runs = useAgentScheduleStore.getState().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("running");
    expect(runs[0].prompt).toBe("Find orders stuck in pending for more than 24 hours.");
  });

  it("never hands the same task to two callers", () => {
    enqueueTask();
    expect(useAgentScheduleStore.getState().claimRunnableTask(CONTEXT)?.scheduleId).toBe("s1");
    // A React double-invoke, or a second effect pass, must come back empty.
    expect(useAgentScheduleStore.getState().claimRunnableTask(CONTEXT)).toBeNull();
  });

  it("hands over one runnable task at a time, in dispatch order", () => {
    enqueueTask();
    enqueueTask({ scheduleId: "s2", name: "Second task" });
    const store = useAgentScheduleStore.getState();
    expect(store.claimRunnableTask(CONTEXT)?.scheduleId).toBe("s1");
    expect(useAgentScheduleStore.getState().claimRunnableTask(CONTEXT)?.scheduleId).toBe("s2");
    expect(useAgentScheduleStore.getState().claimRunnableTask(CONTEXT)).toBeNull();
  });

  it("keeps a task pinned to another connection waiting instead of running it here", () => {
    enqueueTask();
    const store = useAgentScheduleStore.getState();
    expect(store.claimRunnableTask({ ...CONTEXT, connectionId: "conn-b" })).toBeNull();
    expect(useAgentScheduleStore.getState().runs[0].status).toBe("waiting");
  });

  it("waits for a free panel and reports why", () => {
    enqueueTask({ database: null });
    const [task] = useAgentScheduleStore.getState().runs;
    expect(describeTaskWait(task, { ...CONTEXT, isBusy: true })).toBe("busy");
    expect(
      useAgentScheduleStore.getState().claimRunnableTask({ ...CONTEXT, isBusy: true }),
    ).toBeNull();
  });

  it("accepts the active scope for a task that pinned none", () => {
    enqueueTask({ connectionId: null, database: null });
    const [task] = useAgentScheduleStore.getState().runs;
    expect(
      describeTaskWait(task, { connectionId: "any", database: "any", isBusy: false }),
    ).toBeNull();
  });

  it("reports the reason a task is waiting, per bound scope", () => {
    enqueueTask();
    const [task] = useAgentScheduleStore.getState().runs;
    expect(describeTaskWait(task, { ...CONTEXT, database: "crm" })).toBe("database");
    expect(describeTaskWait(task, { ...CONTEXT, connectionId: null })).toBe("connection");
    expect(describeTaskWait(task, CONTEXT)).toBeNull();
  });

  it("reports the outcome to the backend and drops the task", async () => {
    invokeMutationMock.mockResolvedValueOnce(undefined);
    enqueueTask();
    useAgentScheduleStore.getState().claimRunnableTask(CONTEXT);

    const reported = await useAgentScheduleStore.getState().finishAgentTask("s1", {
      status: "ok",
      rows: null,
      summary: "Found 3 stuck orders.",
    });

    expect(reported).toBe(true);
    expect(invokeMutationMock).toHaveBeenCalledWith("complete_agent_schedule_run", {
      scheduleId: "s1",
      status: "ok",
      rows: null,
      error: null,
      summary: "Found 3 stuck orders.",
    });
    expect(useAgentScheduleStore.getState().runs).toEqual([]);
  });

  it("reports a failure as an error and clears the task even when the report fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMutationMock.mockRejectedValueOnce(new Error("backend offline"));
    enqueueTask();

    const reported = await useAgentScheduleStore.getState().finishAgentTask("s1", {
      status: "error",
      error: "Provider returned 500.",
    });

    expect(reported).toBe(false);
    expect(invokeMutationMock).toHaveBeenCalledWith(
      "complete_agent_schedule_run",
      expect.objectContaining({ status: "error", error: "Provider returned 500." }),
    );
    // The queue must not keep a finished run alive, or it would be claimed twice.
    expect(useAgentScheduleStore.getState().runs).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("reports a run that stopped short as needing a human, never as a success", async () => {
    invokeMutationMock.mockResolvedValueOnce(undefined);
    enqueueTask();
    useAgentScheduleStore.getState().claimRunnableTask(CONTEXT);

    const reported = await useAgentScheduleStore.getState().finishAgentTask("s1", {
      status: "needs_human",
      rows: null,
      summary:
        "[read-only] refused 1 blocked tool call(s): preview_write — checked the orders table.",
    });

    expect(reported).toBe(true);
    expect(invokeMutationMock).toHaveBeenCalledWith(
      "complete_agent_schedule_run",
      expect.objectContaining({ status: "needs_human", error: null }),
    );
  });

  it("drops a single task or the whole queue on request", () => {
    enqueueTask();
    enqueueTask({ scheduleId: "s2", name: "Second task" });
    useAgentScheduleStore.getState().dropAgentTask("s1");
    expect(useAgentScheduleStore.getState().runs.map((run) => run.scheduleId)).toEqual(["s2"]);
    useAgentScheduleStore.getState().clearAgentTasks();
    expect(useAgentScheduleStore.getState().runs).toEqual([]);
  });
});
