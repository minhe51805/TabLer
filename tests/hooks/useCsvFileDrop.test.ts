import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

// `useCsvFileDrop` must be a no-op outside Tauri. Regression: it used to call
// `getCurrentWindow()` unconditionally, which throws synchronously when
// `__TAURI_INTERNALS__` is absent (plain browser, vite preview, tests) and
// crashed every non-Tauri boot — the .catch() below never ran.
import { useCsvFileDrop } from "@/hooks/useCsvFileDrop";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => {
    throw new Error("Cannot read properties of undefined (reading 'metadata')");
  }),
}));

describe("useCsvFileDrop", () => {
  it("does not touch the Tauri window bridge when __TAURI_INTERNALS__ is absent", () => {
    // jsdom has no Tauri internals — the hook must return early and never
    // call getCurrentWindow, instead of throwing at effect mount.
    expect(() => renderHook(() => useCsvFileDrop())).not.toThrow();
  });
});
