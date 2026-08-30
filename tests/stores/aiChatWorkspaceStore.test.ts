import { beforeEach, describe, expect, it } from "vitest";
import { inferDatabaseFromWorkspaceName, useAIChatWorkspaceStore } from "../../src/stores/aiChatWorkspaceStore";

describe("aiChatWorkspaceStore", () => {
  beforeEach(() => {
    useAIChatWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null });
  });

  it("creates a workspace, activates it and binds the connection", () => {
    const id = useAIChatWorkspaceStore.getState().createWorkspace("QL_BAN_HANG", "conn-1", "QL_BAN_HANG");
    const state = useAIChatWorkspaceStore.getState();

    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0]).toMatchObject({
      id,
      name: "QL_BAN_HANG",
      connectionId: "conn-1",
      database: "QL_BAN_HANG",
      contextDigest: "",
      contextUpdatedAt: null,
    });
    expect(state.activeWorkspaceId).toBe(id);
  });

  it("bindWorkspaceDatabase pins a database and ignores blank input", () => {
    const id = useAIChatWorkspaceStore.getState().createWorkspace("One", null, null);
    useAIChatWorkspaceStore.getState().bindWorkspaceDatabase(id, "  QL_BAN_HANG ");
    expect(useAIChatWorkspaceStore.getState().workspaces[0].database).toBe("QL_BAN_HANG");

    useAIChatWorkspaceStore.getState().bindWorkspaceDatabase(id, "   ");
    expect(useAIChatWorkspaceStore.getState().workspaces[0].database).toBe("QL_BAN_HANG");
  });

  it("bindWorkspaceDatabase is a no-op when the binding already matches", () => {
    const id = useAIChatWorkspaceStore.getState().createWorkspace("One", null, "dangkytest");
    const before = useAIChatWorkspaceStore.getState().workspaces[0];
    useAIChatWorkspaceStore.getState().bindWorkspaceDatabase(id, "dangkytest");
    expect(useAIChatWorkspaceStore.getState().workspaces[0]).toBe(before);
  });

  it("falls back to a numbered default name for blank input", () => {
    useAIChatWorkspaceStore.getState().createWorkspace("   ");
    const state = useAIChatWorkspaceStore.getState();
    expect(state.workspaces[0].name).toBe("Workspace 1");
  });

  it("renames with trimmed non-empty names only", () => {
    const id = useAIChatWorkspaceStore.getState().createWorkspace("Old");
    useAIChatWorkspaceStore.getState().renameWorkspace(id, "  New name  ");
    expect(useAIChatWorkspaceStore.getState().workspaces[0].name).toBe("New name");

    useAIChatWorkspaceStore.getState().renameWorkspace(id, "   ");
    expect(useAIChatWorkspaceStore.getState().workspaces[0].name).toBe("New name");
  });

  it("deleting the active workspace falls back to the first remaining one", () => {
    const first = useAIChatWorkspaceStore.getState().createWorkspace("One");
    const second = useAIChatWorkspaceStore.getState().createWorkspace("Two");
    expect(useAIChatWorkspaceStore.getState().activeWorkspaceId).toBe(second);

    useAIChatWorkspaceStore.getState().deleteWorkspace(second);
    const state = useAIChatWorkspaceStore.getState();
    expect(state.workspaces.map((workspace) => workspace.id)).toEqual([first]);
    expect(state.activeWorkspaceId).toBe(first);
  });

  it("setActiveWorkspace accepts null for auto/connection mode", () => {
    useAIChatWorkspaceStore.getState().createWorkspace("One");
    useAIChatWorkspaceStore.getState().setActiveWorkspace(null);
    expect(useAIChatWorkspaceStore.getState().activeWorkspaceId).toBeNull();
  });

  it("saveContextDigest stores the digest and ignores empty digests", () => {
    const id = useAIChatWorkspaceStore.getState().createWorkspace("One");
    useAIChatWorkspaceStore.getState().saveContextDigest(id, "Goal: migrate dbo.taikhoan");
    const withDigest = useAIChatWorkspaceStore.getState().workspaces[0];
    expect(withDigest.contextDigest).toBe("Goal: migrate dbo.taikhoan");
    expect(withDigest.contextUpdatedAt).not.toBeNull();

    useAIChatWorkspaceStore.getState().saveContextDigest(id, "   ");
    expect(useAIChatWorkspaceStore.getState().workspaces[0].contextDigest).toBe("Goal: migrate dbo.taikhoan");
  });

  it("inferDatabaseFromWorkspaceName resolves legacy workspace names against the catalog", () => {
    const catalog = [{ name: "dangkytest" }, { name: "QL_BAN_HANG" }, { name: "master" }];

    expect(inferDatabaseFromWorkspaceName("db QL_BAN_HANG", catalog)).toBe("QL_BAN_HANG");
    expect(inferDatabaseFromWorkspaceName("QL_BAN_HANG", catalog)).toBe("QL_BAN_HANG");
    expect(inferDatabaseFromWorkspaceName("  db DANGKYTEST  ", catalog)).toBe("dangkytest");
    expect(inferDatabaseFromWorkspaceName("Phân tích đơn hàng", catalog)).toBeNull();
    expect(inferDatabaseFromWorkspaceName("", catalog)).toBeNull();
    // Ambiguous substring match (e.g. "an" inside two names) must not guess.
    expect(inferDatabaseFromWorkspaceName("an", [{ name: "banhang" }, { name: "quanan" }])).toBeNull();
    expect(inferDatabaseFromWorkspaceName("db banhang", [{ name: "banhang" }, { name: "quanan" }])).toBe("banhang");
    expect(inferDatabaseFromWorkspaceName("db anything", [])).toBeNull();
  });
});
