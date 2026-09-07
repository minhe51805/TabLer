import { describe, expect, it } from "vitest";
import { buildStableRowIdentity } from "@/components/DataGrid/row-identity";

describe("stable row identity", () => {
  it("uses primary-key values instead of the visible row index", () => {
    const columns = [
      { name: "id", is_primary_key: true },
      { name: "label", is_primary_key: false },
    ];

    expect(buildStableRowIdentity([7, "before"], columns))
      .toBe(buildStableRowIdentity([7, "after"], columns));
    expect(buildStableRowIdentity([8, "before"], columns))
      .not.toBe(buildStableRowIdentity([7, "before"], columns));
  });

  it("keeps composite key components and value types distinct", () => {
    const columns = [
      { name: "tenant", is_primary_key: true },
      { name: "id", is_primary_key: true },
    ];

    expect(buildStableRowIdentity(["acme", 1], columns))
      .not.toBe(buildStableRowIdentity(["acme", "1"], columns));
    expect(buildStableRowIdentity(["acme", 1], columns))
      .not.toBe(buildStableRowIdentity(["other", 1], columns));
  });

  it("refuses identity when a primary key is missing or null", () => {
    expect(buildStableRowIdentity([1], [{ name: "value" }])).toBeNull();
    expect(buildStableRowIdentity([null], [{ name: "id", is_primary_key: true }])).toBeNull();
    expect(buildStableRowIdentity([], [{ name: "id", is_primary_key: true }])).toBeNull();
  });
});
