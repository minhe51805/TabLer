import { describe, expect, it } from "vitest";

import { parseConnectionError } from "@/utils/connection-error";

describe("parseConnectionError", () => {
  it("passes through a structured backend error", () => {
    expect(
      parseConnectionError({
        stage: "auth",
        message: "password authentication failed for user alice",
        hint: "Check the username and password.",
      }),
    ).toEqual({
      stage: "auth",
      message: "password authentication failed for user alice",
      hint: "Check the username and password.",
    });
  });

  it("collapses unknown stage strings to 'unknown' but keeps the message", () => {
    expect(parseConnectionError({ stage: "wat", message: "boom", hint: "?" })).toEqual({
      stage: "unknown",
      message: "boom",
      hint: "?",
    });
  });

  it("falls back to String() for plain string rejections", () => {
    expect(parseConnectionError("timeout")).toEqual({
      stage: "unknown",
      message: "timeout",
      hint: "",
    });
  });
  it("falls back to String() when a structured object has a blank message", () => {
    // `record.message` wins only when non-blank; a blank message drops to
    // String(error) — never produces an empty banner.
    const parsed = parseConnectionError({ stage: "tcp", message: "  ", hint: "h" });
    expect(parsed.stage).toBe("tcp");
    expect(parsed.message).toBe("[object Object]");
    expect(parsed.hint).toBe("h");
  });

  it("stringifies nullish and non-object values without throwing", () => {
    expect(parseConnectionError(null)).toEqual({ stage: "unknown", message: "null", hint: "" });
    expect(parseConnectionError(undefined)).toEqual({
      stage: "unknown",
      message: "undefined",
      hint: "",
    });
    expect(parseConnectionError(42)).toEqual({ stage: "unknown", message: "42", hint: "" });
  });
});
