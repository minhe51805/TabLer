import { beforeEach, describe, expect, it } from "vitest";

import { useUIStore } from "./uiStore";
import type { Tab } from "../types";

function makeQueryTab(id: string, extra: Partial<Tab> = {}): Tab {
  return { id, type: "query", title: `Query ${id}`, connectionId: "conn-1", ...extra };
}

function resetStore() {
  useUIStore.setState({
    tabs: [],
    activeTabId: null,
    primaryActiveTabId: null,
    secondaryActiveTabId: null,
    error: null,
  });
}

beforeEach(resetStore);

describe("duplicateTab", () => {
  it("creates an independent copy with the same type, content and connection", () => {
    const source = makeQueryTab("q1", {
      content: "select 1",
      database: "main",
      editorCursor: { lineNumber: 3, column: 5 },
    });
    useUIStore.setState({ tabs: [source], activeTabId: "q1", primaryActiveTabId: "q1" });

    useUIStore.getState().duplicateTab("q1");

    const { tabs, activeTabId } = useUIStore.getState();
    expect(tabs).toHaveLength(2);
    const copy = tabs[1];
    expect(copy.id).not.toBe("q1");
    expect(copy.type).toBe("query");
    expect(copy.content).toBe("select 1");
    expect(copy.connectionId).toBe("conn-1");
    expect(copy.database).toBe("main");
    expect(copy.editorCursor).toEqual({ lineNumber: 3, column: 5 });
    expect(copy.title).toBe("Query q1 (Copy)");
    expect(activeTabId).toBe(copy.id);

    // Mutating the copy must not leak into the source tab.
    useUIStore.getState().updateTab(copy.id, { content: "select 2" });
    expect(useUIStore.getState().tabs[0].content).toBe("select 1");
  });

  it("drops the workspace entity binding and preview flag so the copy cannot overwrite the saved entity", () => {
    const source = makeQueryTab("q1", {
      isPreview: true,
      workspaceEntityId: "entity-9",
      workspaceEntityRevision: "r3",
      workspaceEntityUpdatedAt: "2026-01-01",
    });
    useUIStore.setState({ tabs: [source], activeTabId: "q1", primaryActiveTabId: "q1" });

    useUIStore.getState().duplicateTab("q1");

    const copy = useUIStore.getState().tabs[1];
    expect(copy.workspaceEntityId).toBeUndefined();
    expect(copy.workspaceEntityRevision).toBeUndefined();
    expect(copy.isPreview).toBe(false);
  });
});

describe("split panes", () => {
  it("moveTabToPane moves a tab into the secondary pane and focuses it there", () => {
    useUIStore.setState({
      tabs: [makeQueryTab("a"), makeQueryTab("b")],
      activeTabId: "a",
      primaryActiveTabId: "a",
    });

    useUIStore.getState().moveTabToPane("b", "secondary");

    const state = useUIStore.getState();
    expect(state.tabs.find((tab) => tab.id === "b")?.pane).toBe("secondary");
    expect(state.secondaryActiveTabId).toBe("b");
    expect(state.activeTabId).toBe("b");
    expect(state.primaryActiveTabId).toBe("a");
  });

  it("setActiveTab tracks which pane owns the focused tab", () => {
    useUIStore.setState({
      tabs: [makeQueryTab("a"), makeQueryTab("b", { pane: "secondary" })],
      activeTabId: "b",
      primaryActiveTabId: "a",
      secondaryActiveTabId: "b",
    });

    useUIStore.getState().setActiveTab("a");
    let state = useUIStore.getState();
    expect(state.activeTabId).toBe("a");
    expect(state.primaryActiveTabId).toBe("a");
    expect(state.secondaryActiveTabId).toBe("b");

    useUIStore.getState().setActiveTab("b");
    state = useUIStore.getState();
    expect(state.activeTabId).toBe("b");
    expect(state.secondaryActiveTabId).toBe("b");
    expect(state.primaryActiveTabId).toBe("a");
  });

  it("closing the last secondary tab ends the split and focus returns to the primary pane", () => {
    useUIStore.setState({
      tabs: [makeQueryTab("a"), makeQueryTab("b", { pane: "secondary" })],
      activeTabId: "b",
      primaryActiveTabId: "a",
      secondaryActiveTabId: "b",
    });

    useUIStore.getState().removeTab("b");

    const state = useUIStore.getState();
    expect(state.secondaryActiveTabId).toBeNull();
    expect(state.activeTabId).toBe("a");
    expect(state.primaryActiveTabId).toBe("a");
  });

  it("dragging a tab onto a tab in the other pane moves it there", () => {
    useUIStore.setState({
      tabs: [makeQueryTab("a"), makeQueryTab("b"), makeQueryTab("c", { pane: "secondary" })],
      activeTabId: "a",
      primaryActiveTabId: "a",
      secondaryActiveTabId: "c",
    });

    useUIStore.getState().moveTab("b", "c");

    const state = useUIStore.getState();
    expect(state.tabs.find((tab) => tab.id === "b")?.pane).toBe("secondary");
    // Inserted before the drop target inside the secondary strip.
    expect(state.tabs.map((tab) => tab.id)).toEqual(["a", "b", "c"]);
  });

  it("removeTabsForPane closes every tab in the pane", () => {
    useUIStore.setState({
      tabs: [
        makeQueryTab("a"),
        makeQueryTab("b", { pane: "secondary" }),
        makeQueryTab("c", { pane: "secondary" }),
      ],
      activeTabId: "c",
      primaryActiveTabId: "a",
      secondaryActiveTabId: "c",
    });

    useUIStore.getState().removeTabsForPane("secondary");

    const state = useUIStore.getState();
    expect(state.tabs.map((tab) => tab.id)).toEqual(["a"]);
    expect(state.secondaryActiveTabId).toBeNull();
    expect(state.activeTabId).toBe("a");
  });

  it("duplicating a secondary tab keeps the copy in the secondary pane", () => {
    useUIStore.setState({
      tabs: [makeQueryTab("a"), makeQueryTab("b", { pane: "secondary" })],
      activeTabId: "b",
      primaryActiveTabId: "a",
      secondaryActiveTabId: "b",
    });

    useUIStore.getState().duplicateTab("b");

    const state = useUIStore.getState();
    const copy = state.tabs.find((tab) => tab.id !== "a" && tab.id !== "b");
    expect(copy?.pane).toBe("secondary");
    expect(state.secondaryActiveTabId).toBe(copy?.id);
    expect(state.activeTabId).toBe(copy?.id);
  });
});
