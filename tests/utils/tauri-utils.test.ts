import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((..._args: unknown[]) => new Promise<never>(() => undefined));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { invokeWithTimeout, TauriTimeoutError } from "@/utils/tauri-utils";

describe("Tauri timeout boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
    invokeMock.mockClear();
  });

  it("runs the timeout cleanup callback and returns a typed error", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const request = invokeWithTimeout("slow_command", {}, 5_000, "Slow command", { onTimeout });
    const outcome = request.catch((errorValue) => errorValue);

    await vi.advanceTimersByTimeAsync(5_000);

    const error = await outcome;
    expect(error).toBeInstanceOf(TauriTimeoutError);
    // The message must not claim the backend work was cancelled — the app
    // only stopped waiting; the operation may still be running.
    expect(error instanceof Error ? error.message : String(error)).not.toContain("cancelled");
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});
