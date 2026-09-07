import { describe, it, expect, beforeEach } from "vitest";
import {
  useDbVisibilityStore,
  filterVisibleDatabases,
  getHiddenDatabaseNames,
} from "../../src/stores/dbVisibilityStore";

const dbs = [
  { name: "master" },
  { name: "dangkytest" },
  { name: "QL_BAN_HANG" },
  { name: "tempdb" },
];

describe("dbVisibilityStore", () => {
  beforeEach(() => {
    useDbVisibilityStore.setState({ hiddenDatabases: {} });
  });

  it("returns all databases when nothing is hidden", () => {
    expect(
      filterVisibleDatabases("conn1", dbs, "master", {}),
    ).toHaveLength(4);
  });

  it("hides everything including the connected database", () => {
    useDbVisibilityStore.getState().setHiddenDatabases("conn1", ["QL_BAN_HANG", "dangkytest"]);
    const result = filterVisibleDatabases(
      "conn1",
      dbs,
      "dangkytest",
      useDbVisibilityStore.getState().hiddenDatabases,
    );
    expect(result.map((d) => d.name)).toEqual(["master", "tempdb"]);
  });

  it("scopes hidden list per connection", () => {
    useDbVisibilityStore.getState().setHiddenDatabases("conn1", ["master"]);
    expect(getHiddenDatabaseNames("conn2", useDbVisibilityStore.getState().hiddenDatabases)).toEqual([]);
    expect(getHiddenDatabaseNames("conn1", useDbVisibilityStore.getState().hiddenDatabases)).toEqual(["master"]);
  });

  it("clearHidden restores full visibility", () => {
    useDbVisibilityStore.getState().setHiddenDatabases("conn1", ["master", "tempdb"]);
    useDbVisibilityStore.getState().clearHidden("conn1");
    expect(
      filterVisibleDatabases(
        "conn1",
        dbs,
        null,
        useDbVisibilityStore.getState().hiddenDatabases,
      ),
    ).toHaveLength(4);
  });

  it("stale hidden names that no longer exist are ignored on save", () => {
    // simulate modal save with only names still present in the catalog
    const catalog = new Set(dbs.map((d) => d.name));
    const picked = ["master", "ghost_db"].filter((n) => catalog.has(n));
    useDbVisibilityStore.getState().setHiddenDatabases("conn1", picked);
    expect(useDbVisibilityStore.getState().hiddenDatabases["conn1"]).toEqual(["master"]);
  });
});
