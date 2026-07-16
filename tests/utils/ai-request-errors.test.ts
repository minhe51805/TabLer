import { describe, expect, it } from "vitest";
import {
  AIRequestError,
  normalizeAIRequestError,
} from "@/utils/ai-request-errors";

describe("AI request errors", () => {
  it.each([
    ["AI request cancelled.", "cancelled"],
    ["AI request timed out after 180s", "timeout"],
    ["Provider returned a non-JSON response", "invalid-response"],
    ["AI API error: rate limit reached", "provider"],
  ] as const)("classifies %s as %s", (message, code) => {
    expect(normalizeAIRequestError(new Error(message))).toMatchObject({
      code,
      retryable: true,
    });
  });

  it("preserves an existing typed request error", () => {
    const error = new AIRequestError("provider", "Open settings", false);
    expect(normalizeAIRequestError(error)).toBe(error);
  });

  it("keeps unknown failures non-retryable by default", () => {
    expect(normalizeAIRequestError(new Error("Unexpected state"))).toMatchObject({
      code: "unknown",
      retryable: false,
    });
  });
});
