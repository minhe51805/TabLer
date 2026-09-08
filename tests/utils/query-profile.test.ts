import { describe, expect, it } from "vitest";
import { getNewQueryTabTitle, getQueryProfile } from "@/utils/query-profile";

describe("query profile", () => {
  it("keeps MongoDB on the SQL surface so completions register (regression: 05ca202f)", () => {
    // Mongo tabs accept SQL (the driver translates SELECT/etc. to aggregation
    // pipelines) AND db.* shell commands. The tab must therefore stay a SQL
    // editor — flipping it to the command surface silently removed every
    // suggestion and the SQL highlighting.
    const profile = getQueryProfile("mongodb");
    expect(profile.surface).toBe("sql");
    expect(profile.editorLanguage).toBe("sql");
    // Shell commands keep working through the direct execution path.
    expect(profile.executionPath).toBe("direct");
    expect(profile.defaultTabTitle).toBe("Query");
    expect(profile.defaultContent).toBe("");
  });

  it("keeps Redis on the command surface", () => {
    const profile = getQueryProfile("redis");
    expect(profile.surface).toBe("command");
    expect(profile.editorLanguage).toBe("shell");
    expect(profile.executionPath).toBe("direct");
  });

  it("defaults SQL engines to the SQL surface with the sandbox path", () => {
    const profile = getQueryProfile("postgresql");
    expect(profile.surface).toBe("sql");
    expect(profile.executionPath).toBe("sandbox");
  });

  it("titles Mongo tabs like ordinary query tabs", () => {
    expect(getNewQueryTabTitle("mongodb", 1)).toBe("Query");
    expect(getNewQueryTabTitle("mongodb", 2)).toBe("Query 2");
  });
});
