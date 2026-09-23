/**
 * P10: the app side of the scheduled-agent-task handshake.
 *
 * These tests pin the rules that make an unattended run safe and honest:
 * exactly one task at a time and only in the task's own scope, always read-only
 * with no standing write consent, and a schedule row that only ever shows an
 * outcome the backend accepted.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMutationMock = vi.fn();

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
}));

import { useAgentScheduleRunner } from "@/components/AISlidePanel/hooks/use-agent-schedule-runner";
import { useAgentScheduleStore } from "@/stores/agent-schedule-store";
import { useQuerySchedulesStore, type QuerySchedule } from "@/stores/query-schedules-store";

type RunnerParams = Parameters<typeof useAgentScheduleRunner>[0];
type EnqueueParams = Parameters<
  ReturnType<typeof useAgentScheduleStore.getState>["enqueueAgentTask"]
>[0];

const PROMPT = "Find orders stuck in pending for more than 24 hours.";

/** A finished run, shaped as `use-ai-slide-panel` hands it back. */
function runResult(overrides: { rawResponse?: string; unattendedBlockedTools?: string[] } = {}) {
  return {
    prompt: PROMPT,
    rawResponse: "Orders look healthy.",
    unattendedBlockedTools: [] as string[],
    ...overrides,
  };
}

function agentSchedule(overrides: Partial<QuerySchedule> = {}): QuerySchedule {
  return {
    id: "s1",
    name: "Nightly order check",
    kind: "agent",
    sql: "",
    prompt: PROMPT,
    connectionId: "conn-a",
    database: "shop",
    intervalSeconds: 900,
    enabled: true,
    // The Rust tick dispatched it: the row is waiting for this app to answer.
    lastRanAt: null,
    lastStatus: "dispatched",
    lastRows: null,
    lastError: null,
    lastSummary: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function enqueueTask(overrides: Partial<EnqueueParams> = {}) {
  useAgentScheduleStore.getState().enqueueAgentTask({
    scheduleId: "s1",
    name: "Nightly order check",
    prompt: PROMPT,
    connectionId: "conn-a",
    database: "shop",
    ...overrides,
  });
}

function renderRunner(
  overrides: {
    isGenerating?: boolean;
    connectionId?: string | null;
    currentDatabase?: string | null;
    generateAssist?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const generateAssist = overrides.generateAssist ?? vi.fn().mockResolvedValue(runResult());
  const { rerender } = renderHook((current: RunnerParams) => useAgentScheduleRunner(current), {
    initialProps: {
      generateAssist,
      isGenerating: overrides.isGenerating ?? false,
      connectionId: overrides.connectionId === undefined ? "conn-a" : overrides.connectionId,
      currentDatabase: overrides.currentDatabase === undefined ? "shop" : overrides.currentDatabase,
    } as RunnerParams,
  });
  return { rerender, generateAssist };
}

/**
 * Lets the whole claim → run → report → settle chain drain. The runner finishes a
 * task and then re-checks the queue, so a single microtask flush is not enough.
 */
async function settle() {
  for (let pass = 0; pass < 6; pass += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function scheduleRow() {
  return useQuerySchedulesStore.getState().schedules[0];
}

describe("useAgentScheduleRunner", () => {
  beforeEach(() => {
    invokeMutationMock.mockReset();
    invokeMutationMock.mockResolvedValue(undefined);
    useAgentScheduleStore.setState({ runs: [] });
    useQuerySchedulesStore.setState({ schedules: [agentSchedule()], isLoading: false });
  });

  it("runs a dispatched task read-only and writes back what it found", async () => {
    enqueueTask();
    const { generateAssist } = renderRunner();
    await settle();

    expect(generateAssist).toHaveBeenCalledTimes(1);
    expect(generateAssist).toHaveBeenCalledWith(
      PROMPT,
      [],
      expect.objectContaining({
        interactionMode: "agent",
        userPrompt: PROMPT,
        unattendedReadOnly: true,
      }),
    );
    expect(invokeMutationMock).toHaveBeenCalledWith(
      "complete_agent_schedule_run",
      expect.objectContaining({ scheduleId: "s1", status: "ok", summary: "Orders look healthy." }),
    );
    // A row count nobody measured must not be invented for a multi-read run.
    expect(invokeMutationMock.mock.calls[0][1]).toMatchObject({ rows: null, error: null });
    expect(useAgentScheduleStore.getState().runs).toEqual([]);
    expect(scheduleRow()).toMatchObject({ lastStatus: "ok", lastSummary: "Orders look healthy." });
  });

  it("pre-approves reads only — never a destructive write — when nobody can answer", async () => {
    enqueueTask();
    const { generateAssist } = renderRunner();
    await settle();

    const options = generateAssist.mock.calls[0][2] as {
      requestDataReadConsent?: () => Promise<boolean>;
      requestDataDestructiveConsent?: unknown;
    };
    // Without the per-schedule opt-in the unattended run stays schema-only:
    // shipping rows to the provider needs the explicit allowDataRead grant.
    await expect(options.requestDataReadConsent?.()).resolves.toBe(false);
    // No standing destructive consent: a write stays impossible, not merely
    // "approved in advance".
    expect(options.requestDataDestructiveConsent).toBeUndefined();
  });

  it("honours the per-schedule data-read opt-in", async () => {
    enqueueTask({ allowDataRead: true });
    const { generateAssist } = renderRunner();
    await settle();

    const options = generateAssist.mock.calls[0][2] as {
      requestDataReadConsent?: () => Promise<boolean>;
    };
    // The creation-time checkbox is the consent for reading live data.
    await expect(options.requestDataReadConsent?.()).resolves.toBe(true);
  });

  it("reports a refused write tool as needing a human, never as a success", async () => {
    enqueueTask();
    const { generateAssist } = renderRunner({
      generateAssist: vi.fn().mockResolvedValue(
        runResult({
          rawResponse: "I checked the orders table.",
          unattendedBlockedTools: ["preview_write"],
        }),
      ),
    });
    await settle();

    expect(generateAssist).toHaveBeenCalledTimes(1);
    expect(invokeMutationMock).toHaveBeenCalledWith(
      "complete_agent_schedule_run",
      expect.objectContaining({
        status: "needs_human",
        error: null,
        summary: expect.stringContaining("refused 1 blocked tool call(s): preview_write"),
      }),
    );
    expect(scheduleRow()).toMatchObject({ lastStatus: "needs_human" });
    expect(scheduleRow().lastSummary).toContain("preview_write");
  });

  it("records the provider's own message when the run throws", async () => {
    enqueueTask();
    const { generateAssist } = renderRunner({
      generateAssist: vi.fn().mockRejectedValue(new Error("Provider returned 500.")),
    });
    await settle();

    expect(generateAssist).toHaveBeenCalledTimes(1);
    expect(invokeMutationMock).toHaveBeenCalledWith(
      "complete_agent_schedule_run",
      expect.objectContaining({
        status: "error",
        error: "Provider returned 500.",
        summary: null,
      }),
    );
    expect(scheduleRow()).toMatchObject({ lastStatus: "error", lastSummary: null });
  });

  it("keeps a task waiting rather than running it in another scope", async () => {
    enqueueTask();
    const { generateAssist } = renderRunner({ connectionId: "conn-b", currentDatabase: "shop" });
    await settle();

    expect(generateAssist).not.toHaveBeenCalled();
    expect(invokeMutationMock).not.toHaveBeenCalled();
    // Visible as waiting in the schedules panel, never silently dropped.
    expect(useAgentScheduleStore.getState().runs[0].status).toBe("waiting");
    expect(scheduleRow().lastStatus).toBe("dispatched");
  });

  it("does not run anything without an active connection", async () => {
    enqueueTask();
    const { generateAssist } = renderRunner({ connectionId: null, currentDatabase: null });
    await settle();

    expect(generateAssist).not.toHaveBeenCalled();
    expect(useAgentScheduleStore.getState().runs[0].status).toBe("waiting");
  });

  it("waits for the panel to be free, then runs on the next pass", async () => {
    enqueueTask();
    const generateAssist = vi.fn().mockResolvedValue(runResult());
    const { rerender } = renderRunner({ isGenerating: true, generateAssist });
    await settle();
    expect(generateAssist).not.toHaveBeenCalled();

    rerender({
      generateAssist,
      isGenerating: false,
      connectionId: "conn-a",
      currentDatabase: "shop",
    } as RunnerParams);
    await settle();

    expect(generateAssist).toHaveBeenCalledTimes(1);
    expect(scheduleRow().lastStatus).toBe("ok");
  });

  it("runs one task at a time, in dispatch order", async () => {
    enqueueTask();
    enqueueTask({ scheduleId: "s2", name: "Second task", prompt: "Check refunds." });
    const generateAssist = vi.fn().mockResolvedValue(runResult());
    renderRunner({ generateAssist });
    await settle();

    expect(generateAssist.mock.calls.map(([prompt]) => prompt)).toEqual([PROMPT, "Check refunds."]);
    const reportedIds = invokeMutationMock.mock.calls.map(
      ([, args]) => (args as { scheduleId: string }).scheduleId,
    );
    expect(reportedIds).toEqual(["s1", "s2"]);
    expect(useAgentScheduleStore.getState().runs).toEqual([]);
  });

  it("does not mirror an outcome the backend refused to record", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMutationMock.mockRejectedValueOnce(new Error("backend offline"));
    enqueueTask();
    renderRunner();
    await settle();

    expect(useAgentScheduleStore.getState().runs).toEqual([]);
    // The row still says `dispatched`: the report never landed, so showing the
    // outcome in the UI would be a claim the store did not accept.
    expect(scheduleRow()).toMatchObject({ lastStatus: "dispatched", lastSummary: null });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
