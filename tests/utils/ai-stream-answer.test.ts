import { describe, expect, it } from "vitest";
import { extractStreamingAgentAnswer } from "@/utils/ai-stream-answer";

describe("extractStreamingAgentAnswer", () => {
  it("returns null before the finish action's response field starts", () => {
    expect(extractStreamingAgentAnswer("")).toBeNull();
    expect(extractStreamingAgentAnswer('{"action":"finish","args":{')).toBeNull();
  });

  it("returns null for tool-step actions that carry no response", () => {
    const toolAction = '{"action":"run_readonly_sql","args":{"sql":"SELECT 1"}}';
    expect(extractStreamingAgentAnswer(toolAction)).toBeNull();
  });

  it("extracts the partial answer as the JSON string streams in", () => {
    expect(
      extractStreamingAgentAnswer('{"action":"finish","args":{"response":"Here is'),
    ).toBe("Here is");
    expect(
      extractStreamingAgentAnswer('{"action":"finish","args":{"response":"Here is the answer'),
    ).toBe("Here is the answer");
  });

  it("stops at the closing quote once the value is complete", () => {
    const full = '{"action":"finish","args":{"response":"All done.","sql":"SELECT 1"}}';
    expect(extractStreamingAgentAnswer(full)).toBe("All done.");
  });

  it("decodes JSON string escapes including newlines and quotes", () => {
    const raw = '{"action":"finish","args":{"response":"Line 1\\nLine 2 \\"quoted\\" \\t tab"';
    expect(extractStreamingAgentAnswer(raw)).toBe('Line 1\nLine 2 "quoted" \t tab');
  });

  it("decodes unicode escapes", () => {
    const raw = '{"action":"finish","args":{"response":"caf\\u00e9"}}';
    expect(extractStreamingAgentAnswer(raw)).toBe("café");
  });

  it("drops a dangling escape at the streaming tail", () => {
    // A backslash arrived but its escaped char has not streamed in yet.
    expect(
      extractStreamingAgentAnswer('{"action":"finish","args":{"response":"done\\'),
    ).toBe("done");
  });

  it("waits for a full \\uXXXX before decoding it", () => {
    expect(
      extractStreamingAgentAnswer('{"action":"finish","args":{"response":"caf\\u00'),
    ).toBe("caf");
  });

  it("tolerates whitespace around the response key", () => {
    const raw = '{"action":"finish","args":{ "response" : "spaced"}}';
    expect(extractStreamingAgentAnswer(raw)).toBe("spaced");
  });

  it("returns an empty string when the value has only just opened", () => {
    expect(
      extractStreamingAgentAnswer('{"action":"finish","args":{"response":"'),
    ).toBe("");
  });
});
