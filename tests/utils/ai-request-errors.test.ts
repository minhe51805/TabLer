import { describe, expect, it } from "vitest";
import aiErrorKindContract from "../fixtures/ai-error-kinds.json";
import {
  AI_ERROR_KIND_MARKER_KEY,
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

  // D7: the backend tags each AI error with an authoritative
  // `[ai_error_kind=<code>]` marker. The classifier trusts it over substrings
  // and strips it so it never reaches the user.
  it.each([
    ["timeout", "timeout"],
    ["provider", "provider"],
    ["invalid-response", "invalid-response"],
  ] as const)("classifies a tagged %s marker authoritatively and hides it", (marker, code) => {
    const detail = "Some backend detail the user should read.";
    const normalized = normalizeAIRequestError(
      new Error(`${detail} [${AI_ERROR_KIND_MARKER_KEY}=${marker}]`),
    );
    expect(normalized.code).toBe(code);
    expect(normalized.retryable).toBe(true);
    expect(normalized.message).toBe(detail);
    expect(normalized.message).not.toContain(AI_ERROR_KIND_MARKER_KEY);
  });

  it("trusts a cancelled marker even when the text says otherwise", () => {
    const normalized = normalizeAIRequestError(
      new Error(`The provider returned HTTP 500 [${AI_ERROR_KIND_MARKER_KEY}=cancelled]`),
    );
    expect(normalized.code).toBe("cancelled");
    expect(normalized.message).toBe("AI request cancelled.");
  });

  it("prefers the marker over conflicting substrings", () => {
    // Body literally contains "timed out", but the backend classified it as a
    // provider failure — the marker wins.
    const normalized = normalizeAIRequestError(
      new Error(`The request timed out upstream [${AI_ERROR_KIND_MARKER_KEY}=provider]`),
    );
    expect(normalized.code).toBe("provider");
  });

  it("falls back to substrings for an unrecognized marker value", () => {
    const normalized = normalizeAIRequestError(
      new Error(`Unexpected state [${AI_ERROR_KIND_MARKER_KEY}=bogus]`),
    );
    expect(normalized.code).toBe("unknown");
    expect(normalized.retryable).toBe(false);
    // The unrecognized marker is still stripped from the surfaced message.
    expect(normalized.message).toBe("Unexpected state");
  });

  it("keeps the retry_after_ms hint when a kind marker is also present", () => {
    const normalized = normalizeAIRequestError(
      new Error(`Rate limited (retry_after_ms=4000). [${AI_ERROR_KIND_MARKER_KEY}=provider]`),
    );
    expect(normalized.code).toBe("provider");
    expect(normalized.providerRetryAfterMs).toBe(4000);
  });

  // Cross-language contract shared with the Rust side
  // (`src-tauri/src/commands/ai/errors.rs`). If the marker key or the set of
  // kinds drifts, one side fails.
  it("recognizes every backend-emitted kind from the shared contract", () => {
    expect(aiErrorKindContract.markerKey).toBe(AI_ERROR_KIND_MARKER_KEY);
    for (const kind of aiErrorKindContract.kinds) {
      const normalized = normalizeAIRequestError(
        new Error(`Backend failure [${AI_ERROR_KIND_MARKER_KEY}=${kind}]`),
      );
      expect(normalized.code).toBe(kind);
    }
  });
});
