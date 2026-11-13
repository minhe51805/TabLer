import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn(
  (..._args: unknown[]): Promise<unknown> => new Promise<never>(() => undefined),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  invokeCommand,
  invokeMutation,
  invokeWithTimeout,
  TauriCommandError,
  TauriTimeoutError,
} from "@/utils/tauri-utils";

describe("Tauri IPC boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
    invokeMock.mockReset();
  });

  it("runs the timeout cleanup callback and returns a typed error", async () => {
    invokeMock.mockImplementation(() => new Promise<never>(() => undefined));
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const request = invokeWithTimeout("slow_command", {}, 5_000, "Slow command", { onTimeout });
    const outcome = request.catch((errorValue) => errorValue);

    await vi.advanceTimersByTimeAsync(5_000);

    const error = await outcome;
    expect(error).toBeInstanceOf(TauriTimeoutError);
    expect(error instanceof Error ? error.message : String(error)).not.toContain("cancelled");
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("normalizes structured Rust AppError rejections into TauriCommandError", async () => {
    invokeMock.mockRejectedValueOnce({
      code: "ai-rate-limited",
      message: "Provider quota exceeded",
      retryable: true,
      retryAfterMs: 4000,
    });

    const caught = await invokeMutation("ask_ai", { request: {} }).catch((err) => err);
    expect(caught).toBeInstanceOf(TauriCommandError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({
      code: "ai-rate-limited",
      message: "Provider quota exceeded",
      retryable: true,
      retryAfterMs: 4000,
    });
  });

  it("preserves connection stage and hint metadata on TauriCommandError", async () => {
    invokeMock.mockRejectedValueOnce({
      code: "connection-error",
      message: "Authentication failed",
      retryable: false,
      stage: "auth",
      hint: "Verify password",
    });

    const caught = await invokeCommand("connect_database", { config: {} }).catch((err) => err);
    expect(caught).toBeInstanceOf(TauriCommandError);
    expect(caught).toMatchObject({
      code: "connection-error",
      message: "Authentication failed",
      retryable: false,
      stage: "auth",
      hint: "Verify password",
    });
  });

  it("omits second argument when invokeCommand is called with no args", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await invokeCommand("drain_storage_notices");
    expect(invokeMock).toHaveBeenCalledWith("drain_storage_notices");
  });
});
