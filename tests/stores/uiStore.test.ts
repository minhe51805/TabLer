import { beforeEach, describe, expect, it } from "vitest";

import { useUIStore } from "@/stores/uiStore";
import type { Tab } from "@/types";

const queryTab = (id: string): Tab => ({
  id,
  type: "query",
  title: `Query ${id}`,
  connectionId: "connection-1",
});

describe("uiStore", () => {
  beforeEach(() => {
    useUIStore.setState({ tabs: [], activeTabId: null, error: null });
  });

  it("adds and activates a tab", () => {
    useUIStore.getState().addTab(queryTab("one"));

    expect(useUIStore.getState().tabs).toHaveLength(1);
    expect(useUIStore.getState().activeTabId).toBe("one");
  });

  it("activates an existing tab without duplicating it", () => {
    const store = useUIStore.getState();
    store.addTab(queryTab("one"));
    store.addTab(queryTab("two"));
    store.addTab(queryTab("one"));

    expect(useUIStore.getState().tabs.map((tab) => tab.id)).toEqual(["one", "two"]);
    expect(useUIStore.getState().activeTabId).toBe("one");
  });

  it("recycles one preview tab and keeps pinned tabs", () => {
    const store = useUIStore.getState();
    store.addTab({ ...queryTab("preview-one"), isPreview: true });
    store.addTab({ ...queryTab("preview-two"), isPreview: true });

    expect(useUIStore.getState().tabs.map((tab) => tab.id)).toEqual(["preview-two"]);

    store.pinTab("preview-two");
    store.addTab({ ...queryTab("preview-three"), isPreview: true });

    expect(useUIStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "preview-two",
      "preview-three",
    ]);
    expect(useUIStore.getState().tabs[0]?.isPreview).toBe(false);
  });

  it("falls back to the last visible tab when the active tab closes", () => {
    const store = useUIStore.getState();
    store.addTab(queryTab("one"));
    store.addTab(queryTab("two"));
    store.removeTab("two");

    expect(useUIStore.getState().activeTabId).toBe("one");
  });

  it("keeps metrics tabs when clearing the workspace", () => {
    const store = useUIStore.getState();
    store.addTab(queryTab("one"));
    store.addTab({
      id: "metrics",
      type: "metrics",
      title: "Metrics",
      connectionId: "connection-1",
    });
    store.clearTabs();

    expect(useUIStore.getState().tabs.map((tab) => tab.id)).toEqual(["metrics"]);
    expect(useUIStore.getState().activeTabId).toBeNull();
  });

  it("updates a tab and manages the shared error", () => {
    const store = useUIStore.getState();
    store.addTab(queryTab("one"));
    store.updateTab("one", { title: "Renamed" });
    store.setError("Unable to load schema");

    expect(useUIStore.getState().tabs[0]?.title).toBe("Renamed");
    expect(useUIStore.getState().error).toBe("Unable to load schema");

    useUIStore.getState().clearError();
    expect(useUIStore.getState().error).toBeNull();
  });

  it("removes all tabs for a connection and preserves unrelated tabs", () => {
    const store = useUIStore.getState();
    store.addTab(queryTab("one"));
    store.addTab({ ...queryTab("two"), connectionId: "connection-2" });
    store.removeTabsForConnection("connection-2");

    expect(useUIStore.getState().tabs.map((tab) => tab.id)).toEqual(["one"]);
    expect(useUIStore.getState().activeTabId).toBe("one");
  });
});
