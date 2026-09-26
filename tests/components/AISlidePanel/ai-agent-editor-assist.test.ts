import { describe, expect, it } from "vitest";
import { parseEditorAssistCommand } from "@/components/AISlidePanel/ai-slash-commands";

describe("parseEditorAssistCommand", () => {
  it("parses /fix case-insensitively with the trailing hint preserved", () => {
    expect(parseEditorAssistCommand("/FIX only the join is wrong")).toEqual({
      command: "fix",
      arguments: "only the join is wrong",
    });
    expect(parseEditorAssistCommand("/Explain the WHERE clause")).toEqual({
      command: "explain",
      arguments: "the WHERE clause",
    });
    expect(parseEditorAssistCommand("/optimize")).toEqual({
      command: "optimize",
      arguments: "",
    });
  });

  it("returns null for non-assist commands and plain prompts", () => {
    expect(parseEditorAssistCommand("/backup")).toBeNull();
    expect(parseEditorAssistCommand("/rollback")).toBeNull();
    expect(parseEditorAssistCommand("/fixer")).toBeNull(); // prefix is not the command
    expect(parseEditorAssistCommand("fix this query")).toBeNull();
    expect(parseEditorAssistCommand("SELECT 1")).toBeNull();
    expect(parseEditorAssistCommand("")).toBeNull();
  });
});
