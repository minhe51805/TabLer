import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

// Wrap getQueryProfile so we can count how many times it runs. `getTabIcon`
// calls it exactly once per rendered *query* tab, so the call count is a
// precise proxy for "how many TabBarItem bodies executed this commit".
vi.mock("@/utils/query-profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/query-profile")>();
  return {
    ...actual,
    getQueryProfile: vi.fn(actual.getQueryProfile),
  };
});

import { TabBar } from "@/components/TabBar/TabBar";
import { getQueryProfile } from "@/utils/query-profile";
import { useConnectionStore } from "@/stores/connectionStore";
import { useUIStore } from "@/stores/uiStore";
import type { Tab } from "@/types";
import type { ConnectionConfig } from "@/types/database";

const renderProbe = getQueryProfile as unknown as ReturnType<typeof vi.fn>;

const connection: ConnectionConfig = {
  id: "conn-1",
  name: "Local",
  db_type: "sqlite",
  use_ssl: false,
};

function makeQueryTab(id: string): Tab {
  return { id, type: "query", title: `Query ${id}`, connectionId: "conn-1" };
}

beforeEach(() => {
  renderProbe.mockClear();
  useConnectionStore.setState({ connections: [connection] });
});

afterEach(() => {
  cleanup();
  useUIStore.setState({ tabs: [], activeTabId: null });
});

describe("TabBar (Phase 3C follow-up #2 — per-tab re-render)", () => {
  it("switching the active tab re-renders only the two affected tabs, not the whole strip", () => {
    const tabs = Array.from({ length: 6 }, (_, index) => makeQueryTab(`t${index}`));
    useUIStore.setState({ tabs, activeTabId: "t0" });

    render(<TabBar />);
    // Initial mount renders every tab once.
    expect(renderProbe).toHaveBeenCalledTimes(tabs.length);

    renderProbe.mockClear();
    act(() => {
      useUIStore.getState().setActiveTab("t3");
    });

    // With TabBarItem memoized and stable props, only the previously-active
    // tab (t0) and the newly-active tab (t3) re-render — 2, not 6.
    expect(renderProbe).toHaveBeenCalledTimes(2);
  });

  it("moves the active styling to the selected tab and keeps every tab mounted", () => {
    const tabs = [makeQueryTab("a"), makeQueryTab("b"), makeQueryTab("c")];
    useUIStore.setState({ tabs, activeTabId: "a" });
    const { container } = render(<TabBar />);

    const items = () => Array.from(container.querySelectorAll<HTMLElement>(".tabbar-tab"));
    expect(items()).toHaveLength(3);
    expect(items()[0].className).toContain("active");

    act(() => {
      useUIStore.getState().setActiveTab("c");
    });

    const after = items();
    expect(after).toHaveLength(3);
    expect(after[0].className).not.toContain("active");
    expect(after[2].className).toContain("active");
  });
});
