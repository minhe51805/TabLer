import { describe, expect, it } from "vitest";
import { extractNamedSqlParameters, toQueryParameters } from "../../src/utils/sql-parameters";

describe("SQL parameter parsing", () => {
  it("finds placeholders without interpreting literals, casts, comments, or dollar bodies", () => {
    expect(extractNamedSqlParameters("SELECT :name::text, '$skip', $body$ :skip $body$ -- @skip\nWHERE id = $id")).toEqual(["name", "id"]);
  });

  it("coerces typed values without interpolating them into SQL", () => {
    expect(toQueryParameters(["limit", "enabled"], {
      limit: { value: "20", dataType: "integer" },
      enabled: { value: "true", dataType: "boolean" },
    })).toEqual([
      { name: "limit", value: 20, dataType: "integer" },
      { name: "enabled", value: true, dataType: "boolean" },
    ]);
  });
});
