import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const invokeMutationMock = vi.fn();
const invokeWithTimeoutMock = vi.fn();

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
  invokeWithTimeout: (...args: unknown[]) => invokeWithTimeoutMock(...args),
}));

import { useTabPersistence } from "@/hooks/useTabPersistence";
import { useUIStore } from "@/stores/uiStore";
import type { PersistedTab } from "@/utils/tab-persistence";
import type { Tab } from "@/types";

const persistedTab = (overrides: Partial<PersistedTab> = {}): PersistedTab => ({
  tabId: "tab-a",
  tabType: "query",
  title: "Saved query",
  content: "SELECT 1",
  isActive: false,
  createdAtMs: 1,
  ...overrides,
});

beforeEach(() => {
  invokeMutationMock.mockReset().mockResolvedValue(undefined);
  invokeWithTimeoutMock.mockReset().mockResolvedValue([]);
  useUIStore.setState({ tabs: [], activeTabId: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("useTabPersistence restore", () => {
  it("restores persisted tabs and re-activates the persisted active tab", async () => {
    invokeWithTimeoutMock.mockResolvedValue([
      persistedTab({ tabId: "tab-a", title: "A" }),
      persistedTab({ tabId: "tab-b", title: "B", isActive: true }),
    ]);
    renderHook(() => useTabPersistence("conn-1", new Set(["conn-1"])));

    await vi.waitFor(() =>
      expect(useUIStore.getState().tabs.map((tab: Tab) => tab.id)).toEqual(["tab-a", "tab-b"]),
    );
    expect(useUIStore.getState().activeTabId).toBe("tab-b");
    expect(invokeWithTimeoutMock).toHaveBeenCalledWith(
      "load_tabs",
      { connectionId: "conn-1" },
      15_000,
      "Loading persisted tabs",
    );
  });

  it("does not duplicate a tab that is already open", async () => {
    useUIStore.getState().addTab({
      id: "tab-a",
      type: "query",
      title: "Live copy",
      connectionId: "conn-1",
      content: "SELECT live",
    });
    invokeWithTimeoutMock.mockResolvedValue([
      persistedTab({ tabId: "tab-a", title: "Stale copy", content: "SELECT stale" }),
      persistedTab({ tabId: "tab-c", title: "C" }),
    ]);

    renderHook(() => useTabPersistence("conn-1", new Set(["conn-1"])));

    await vi.waitFor(() =>
      expect(useUIStore.getState().tabs.map((tab: Tab) => tab.id)).toEqual(["tab-a", "tab-c"]),
    );
    // The live tab wins: its content and title are untouched.
    expect(useUIStore.getState().tabs[0]).toMatchObject({
      title: "Live copy",
      content: "SELECT live",
    });
  });

  it("does nothing when the connection is not connected", async () => {
    renderHook(() => useTabPersistence("conn-1", new Set()));

    await act(async () => Promise.resolve());
    expect(invokeWithTimeoutMock).not.toHaveBeenCalled();
    expect(useUIStore.getState().tabs).toEqual([]);
  });
});

describe("useTabPersistence save", () => {
  it("persists on mount and again when tabs change", async () => {
    const { unmount } = renderHook(() => useTabPersistence("conn-1", new Set(["conn-1"])));

    await vi.waitFor(() =>
      expect(
        invokeMutationMock.mock.calls.filter(([command]) => command === "save_tabs").length,
      ).toBeGreaterThanOrEqual(1),
    );
    const baseline = invokeMutationMock.mock.calls.filter(
      ([command]) => command === "save_tabs",
    ).length;

    act(() => {
      useUIStore.getState().addTab({
        id: "tab-new",
        type: "query",
        title: "New",
        connectionId: "conn-1",
      });
    });

    await vi.waitFor(() => {
      const saves = invokeMutationMock.mock.calls.filter(([command]) => command === "save_tabs");
      expect(saves.length).toBeGreaterThan(baseline);
      const lastSave = saves[saves.length - 1][1] as { tabsJson: string };
      expect(JSON.parse(lastSave.tabsJson)).toEqual([
        expect.objectContaining({ tabId: "tab-new", isActive: true }),
      ]);
    });
    unmount();
  });

  it("persists on beforeunload", async () => {
    const { unmount } = renderHook(() => useTabPersistence("conn-1", new Set(["conn-1"])));
    await vi.waitFor(() => expect(invokeMutationMock).toHaveBeenCalled());
    invokeMutationMock.mockClear();

    act(() => {
      window.dispatchEvent(new Event("beforeunload"));
    });

    await vi.waitFor(() =>
      expect(invokeMutationMock.mock.calls.some(([command]) => command === "save_tabs")).toBe(true),
    );
    unmount();
  });
});
