import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  denyPendingAISqlConfirmation,
  requestAISqlConfirmation,
  setAISqlConfirmHostMounted,
} from "@/components/AISlidePanel/ai-sql-confirm";
import { isSingleSqlStatement } from "@/components/AISlidePanel/ai-panel-selection";
import { requestAppConfirmation } from "@/stores/confirmStore";

vi.mock("@/stores/confirmStore", () => ({
  requestAppConfirmation: vi.fn().mockResolvedValue(true),
}));

const REQUEST_EVENT = "ai-sql-confirm-request";
const RESPONSE_EVENT = "ai-sql-confirm-response";

/** Captures the request detail dispatched to the dialog host. */
function watchRequests() {
  const seen: Array<{ id: number; requirement: unknown; statements: string[] }> = [];
  const listener = (event: Event) => {
    seen.push((event as CustomEvent<(typeof seen)[number]>).detail);
  };
  window.addEventListener(REQUEST_EVENT, listener);
  return { seen, detach: () => window.removeEventListener(REQUEST_EVENT, listener) };
}

function respond(id: number, approved: boolean) {
  window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: { id, approved } }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Leave no host mounted / pending request behind for the next file or test.
  setAISqlConfirmHostMounted(false);
  denyPendingAISqlConfirmation();
});

describe("requestAISqlConfirmation", () => {
  it("resolves true immediately for a null requirement", async () => {
    await expect(requestAISqlConfirmation(null, ["DELETE FROM t"])).resolves.toBe(true);
    expect(requestAppConfirmation).not.toHaveBeenCalled();
  });

  it("falls back to the app-wide confirm dialog when no host is mounted", async () => {
    setAISqlConfirmHostMounted(false);
    const approved = requestAISqlConfirmation("mutation", ["UPDATE t SET x = 1"]);
    await expect(approved).resolves.toBe(true);
    expect(requestAppConfirmation).toHaveBeenCalledTimes(1);
    const call = vi.mocked(requestAppConfirmation).mock.calls[0]?.[0];
    expect(call?.title).toBe("Run write SQL?");
  });

  it("uses the high-risk copy for high-risk requirements", async () => {
    setAISqlConfirmHostMounted(false);
    await requestAISqlConfirmation("high-risk", ["DROP TABLE t"]);
    const call = vi.mocked(requestAppConfirmation).mock.calls[0]?.[0];
    expect(call?.title).toBe("Run high-risk SQL?");
    expect(call?.message).toContain("high-risk");
  });

  it("a second request resolves the first as denied (single-slot)", async () => {
    setAISqlConfirmHostMounted(true);
    const watcher = watchRequests();
    try {
      const first = requestAISqlConfirmation("mutation", ["UPDATE t SET x = 1"]);
      const second = requestAISqlConfirmation("mutation", ["UPDATE t SET x = 2"]);
      await expect(first).resolves.toBe(false);
      // The newest request is the live one; approve it and it resolves true.
      const latest = watcher.seen[watcher.seen.length - 1];
      expect(latest).toBeDefined();
      respond(latest!.id, true);
      await expect(second).resolves.toBe(true);
    } finally {
      watcher.detach();
    }
  });

  it("denyPendingAISqlConfirmation settles the in-flight request as denied", async () => {
    setAISqlConfirmHostMounted(true);
    const pending = requestAISqlConfirmation("mutation", ["UPDATE t SET x = 1"]);
    denyPendingAISqlConfirmation();
    await expect(pending).resolves.toBe(false);
  });

  it("host unmount mid-flight settles the pending request as denied", async () => {
    setAISqlConfirmHostMounted(true);
    const pending = requestAISqlConfirmation("mutation", ["UPDATE t SET x = 1"]);
    setAISqlConfirmHostMounted(false);
    await expect(pending).resolves.toBe(false);
  });

  it("ignores responses addressed to a different request id", async () => {
    setAISqlConfirmHostMounted(true);
    const watcher = watchRequests();
    try {
      const pending = requestAISqlConfirmation("mutation", ["UPDATE t SET x = 1"]);
      const id = watcher.seen[watcher.seen.length - 1]!.id;
      respond(id + 999, true); // stale id — must not resolve
      respond(id, false);
      await expect(pending).resolves.toBe(false);
    } finally {
      watcher.detach();
    }
  });
});

describe("isSingleSqlStatement", () => {
  it("accepts exactly one statement and rejects multi-statement batches", () => {
    expect(isSingleSqlStatement("SELECT 1")).toBe(true);
    expect(isSingleSqlStatement("SELECT 1;")).toBe(true);
    expect(isSingleSqlStatement("SELECT 1; SELECT 2")).toBe(false);
    expect(isSingleSqlStatement("UPDATE t SET x = 1; DROP TABLE t")).toBe(false);
    // A semicolon inside a string literal is not a statement boundary.
    expect(isSingleSqlStatement("SELECT ';'")).toBe(true);
    expect(isSingleSqlStatement("   ")).toBe(false);
  });
});
