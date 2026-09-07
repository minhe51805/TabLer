import { describe, expect, it } from "vitest";
import {
  buildDatabaseObjectKey,
  buildQualifiedObjectIdentity,
} from "../../src/utils/database-object-identity";

describe("database object identity", () => {
  it("distinguishes same-named objects by connection, database, and schema", () => {
    const base = { object: "users" };
    const keys = [
      buildDatabaseObjectKey({ ...base, connectionId: "a", database: "app", schema: "public" }),
      buildDatabaseObjectKey({ ...base, connectionId: "b", database: "app", schema: "public" }),
      buildDatabaseObjectKey({ ...base, connectionId: "a", database: "audit", schema: "public" }),
      buildDatabaseObjectKey({ ...base, connectionId: "a", database: "app", schema: "private" }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not collide when identifiers contain the old delimiter", () => {
    const first = buildDatabaseObjectKey({ connectionId: "a|b", database: null, schema: null, object: "users" });
    const second = buildDatabaseObjectKey({ connectionId: "a", database: "b", schema: null, object: "users" });
    expect(first).not.toBe(second);
  });

  it("extracts schema from qualified table names", () => {
    expect(buildQualifiedObjectIdentity("connection", "audit.events", "app")).toEqual({
      connectionId: "connection",
      database: "app",
      schema: "audit",
      object: "events",
    });
  });
});
