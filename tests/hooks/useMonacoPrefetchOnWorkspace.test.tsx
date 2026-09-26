import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

// The Monaco prefetch used to fire unconditionally at boot (main.tsx), which
// meant "Monaco is lazy" was only true on paper — every session fetched
// ~3.9 MB right after first paint. The hook gates it on workspace entry:
// a launcher-only session must never warm the chunk.
import { useMonacoPrefetchOnWorkspace } from "@/hooks/useMonacoPrefetchOnWorkspace";

const prefetchMonacoBundle = vi.fn();

vi.mock("@/utils/monaco-prefetch", () => ({
  prefetchMonacoBundle: () => prefetchMonacoBundle(),
}));

describe("useMonacoPrefetchOnWorkspace", () => {
  it("does not warm Monaco while the app sits on the launcher", async () => {
    prefetchMonacoBundle.mockClear();
    renderHook(() => useMonacoPrefetchOnWorkspace(false));
    await vi.waitFor(() => expect(prefetchMonacoBundle).not.toHaveBeenCalled(), {
      timeout: 200,
    });
  });

  it("warms Monaco exactly once when a workspace becomes active", async () => {
    prefetchMonacoBundle.mockClear();
    const { rerender } = renderHook(({ active }) => useMonacoPrefetchOnWorkspace(active), {
      initialProps: { active: false },
    });
    rerender({ active: true });
    await vi.waitFor(() => expect(prefetchMonacoBundle).toHaveBeenCalledTimes(1));
    rerender({ active: false });
    rerender({ active: true });
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
    expect(prefetchMonacoBundle).toHaveBeenCalledTimes(1);
  });
});
