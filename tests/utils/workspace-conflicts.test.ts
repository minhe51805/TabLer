import { describe, expect, it } from "vitest";
import {
  planWorkspaceMerge,
  resolveWorkspaceConflicts,
} from "../../src/utils/workspace-conflicts";
import type { WorkspaceBundle, WorkspaceBundleQuery } from "../../src/utils/workspace-bundle";

function query(id: string, revision: string, sql: string): WorkspaceBundleQuery {
  return { id, revision, updatedAt: "2026-07-15T00:00:00Z", title: id, sql };
}

function bundle(queries: WorkspaceBundleQuery[]): WorkspaceBundle {
  return {
    format: "tabler-workspace",
    version: 2,
    exportedAt: "2026-07-15T00:00:00Z",
    target: { databaseType: "postgresql" },
    layout: { sidebarCollapsed: false, sidebarWidth: 320, leftPanel: "database" },
    connections: [],
    queries,
    dashboards: [],
    erViews: [],
  };
}

describe("workspace conflict resolution", () => {
  it("merges one-sided changes without creating a conflict", () => {
    const base = bundle([query("q1", "base", "SELECT 1")]);
    const local = bundle([query("q1", "local", "SELECT 2")]);
    const remote = bundle([query("q1", "base", "SELECT 1")]);
    const plan = planWorkspaceMerge(local, remote, base);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.merged.queries[0].sql).toBe("SELECT 2");
  });

  it("surfaces both-edited conflicts and requires an explicit choice", () => {
    const base = bundle([query("q1", "base", "SELECT 1")]);
    const local = bundle([query("q1", "local", "SELECT 2")]);
    const remote = bundle([query("q1", "remote", "SELECT 3")]);
    const plan = planWorkspaceMerge(local, remote, base);
    expect(plan.conflicts).toMatchObject([{ kind: "saved-query", reason: "both-edited" }]);
    expect(() => resolveWorkspaceConflicts(plan, {})).toThrow("has not been resolved");
    expect(resolveWorkspaceConflicts(plan, { "saved-query:q1": "remote" }).queries[0].sql).toBe("SELECT 3");
  });

  it("never permits connection metadata to be auto-duplicated", () => {
    const local = bundle([]);
    const remote = bundle([]);
    local.connections = [{ id: "c", revision: "l", updatedAt: "2026-07-15T00:00:00Z", name: "Local", databaseType: "postgresql" }];
    remote.connections = [{ id: "c", revision: "r", updatedAt: "2026-07-15T00:00:00Z", name: "Remote", databaseType: "postgresql" }];
    const plan = planWorkspaceMerge(local, remote);
    expect(() => resolveWorkspaceConflicts(plan, { "connection:c": "duplicate" })).toThrow("cannot be duplicated");
  });
});
