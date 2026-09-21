// Regression tests for connection-group persistence and assignment.
import { describe, expect, it, beforeEach } from "vitest";
import {
  applyConnectionAssignments,
  assignConnectionToGroup,
  createGroup,
  deleteGroup,
  getCollapsedGroupIds,
  getGroups,
  toggleGroupCollapse,
} from "./connection-group-store";
import type { ConnectionConfig } from "../types";

const conn = (id: string): ConnectionConfig =>
  ({ id, name: id, db_type: "sqlite", use_ssl: false }) as ConnectionConfig;

describe("connection-group-store", () => {
  beforeEach(() => window.localStorage.clear());

  it("creates groups, assigns connections, applies assignments", () => {
    const g = createGroup("Prod", "#e74c3c");
    assignConnectionToGroup("c1", g.id);
    assignConnectionToGroup("c2", null);

    const applied = applyConnectionAssignments([conn("c1"), conn("c2")]);
    expect(applied[0].groupId).toBe(g.id);
    expect(applied[1].groupId).toBeUndefined();
    expect(getGroups()).toHaveLength(1);
  });

  it("deleting a group clears assignments", () => {
    const g = createGroup("Staging", "#3498db");
    assignConnectionToGroup("c1", g.id);
    deleteGroup(g.id);
    const applied = applyConnectionAssignments([conn("c1")]);
    expect(applied[0].groupId).toBeUndefined();
    expect(getGroups()).toHaveLength(0);
  });

  it("collapse state toggles and persists", () => {
    expect(toggleGroupCollapse("g1")).toBe(true);
    expect(getCollapsedGroupIds().has("g1")).toBe(true);
    expect(toggleGroupCollapse("g1")).toBe(false);
    expect(getCollapsedGroupIds().has("g1")).toBe(false);
  });
});
