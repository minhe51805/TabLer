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

  // Contract with the Rust side (`commands/ai/errors.rs`): retryable provider
  // HTTP failures (429/5xx) embed a machine-readable `retry_after_ms=<n>`
  // marker built from the provider's Retry-After header. This pins the exact
  // sentence shape both ends agree on.
  it("extracts the backend retry_after_ms marker from provider HTTP errors", () => {
    const message =
      'The AI provider "OpenAI" at api.openai.com returned HTTP 429 Too Many Requests. '
      + "This looks temporary on the provider side. It asks to retry after 4 s (retry_after_ms=4000).";
    const normalized = normalizeAIRequestError(new Error(message));
    expect(normalized.code).toBe("provider");
    expect(normalized.retryable).toBe(true);
    expect(normalized.providerRetryAfterMs).toBe(4000);
  });

  it("treats retryable provider failures without the marker as retryable with no wait hint", () => {
    const message =
      'The AI provider "OpenAI" at api.openai.com returned HTTP 503 Service Unavailable. '
      + "This looks temporary on the provider side. Please try again in a moment.";
    const normalized = normalizeAIRequestError(new Error(message));
    expect(normalized.code).toBe("provider");
    expect(normalized.retryable).toBe(true);
    expect(normalized.providerRetryAfterMs).toBeUndefined();
  });
});
