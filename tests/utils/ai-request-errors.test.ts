import { describe, expect, it } from "vitest";
import aiErrorKindContract from "../fixtures/ai-error-kinds.json";
import { AIRequestError, normalizeAIRequestError } from "@/utils/ai-request-errors";
import { TauriCommandError } from "@/utils/tauri-utils";

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

  it("classifies structured TauriCommandError codes authoritatively with retryAfterMs", () => {
    const rateLimited = normalizeAIRequestError(
      new TauriCommandError({
        code: "ai-rate-limited",
        message: 'The AI provider "OpenAI" returned HTTP 429 Too Many Requests.',
        retryable: true,
        retryAfterMs: 4000,
      }),
    );
    expect(rateLimited).toMatchObject({
      code: "provider",
      backendCode: "ai-rate-limited",
      retryable: true,
      providerRetryAfterMs: 4000,
    });

    const authError = normalizeAIRequestError(
      new TauriCommandError({
        code: "ai-auth",
        message: 'The AI provider "OpenAI" returned HTTP 401 Unauthorized.',
        retryable: false,
      }),
    );
    expect(authError).toMatchObject({
      code: "provider",
      backendCode: "ai-auth",
      retryable: false,
    });

    const badRequest = normalizeAIRequestError(
      new TauriCommandError({
        code: "ai-bad-request",
        message: "Invalid parameter",
        retryable: false,
      }),
    );
    expect(badRequest).toMatchObject({
      code: "provider",
      backendCode: "ai-bad-request",
      retryable: false,
    });

    const localLimiter = normalizeAIRequestError(
      new TauriCommandError({
        code: "rate-limited",
        message: "Too many AI requests in a short time.",
        retryable: false,
      }),
    );
    expect(localLimiter).toMatchObject({
      code: "provider",
      backendCode: "rate-limited",
      retryable: false,
    });
  });

  it("prefers structured backend code over conflicting substrings in message", () => {
    const cancelled = normalizeAIRequestError(
      new TauriCommandError({
        code: "ai-cancelled",
        message: "The provider returned HTTP 500",
        retryable: true,
      }),
    );
    expect(cancelled.code).toBe("cancelled");
    expect(cancelled.message).toBe("AI request cancelled.");

    const transient = normalizeAIRequestError(
      new TauriCommandError({
        code: "ai-provider-transient",
        message: "The request timed out upstream",
        retryable: true,
      }),
    );
    expect(transient.code).toBe("provider");
    expect(transient.backendCode).toBe("ai-provider-transient");
  });

  it("still extracts legacy retry_after_ms hints from plain Error mocks", () => {
    const normalized = normalizeAIRequestError(
      new Error(
        'The AI provider "OpenAI" returned HTTP 429 Too Many Requests. It asks to retry after 4 s (retry_after_ms=4000).',
      ),
    );
    expect(normalized.code).toBe("provider");
    expect(normalized.retryable).toBe(true);
    expect(normalized.providerRetryAfterMs).toBe(4000);
  });

  it("recognizes every backend-emitted AI ErrorCode from the shared contract", () => {
    expect(aiErrorKindContract.codes.length).toBeGreaterThan(0);
    for (const backendCode of aiErrorKindContract.codes) {
      const normalized = normalizeAIRequestError(
        new TauriCommandError({
          code: backendCode,
          message: "Backend failure",
          retryable:
            backendCode !== "ai-auth" &&
            backendCode !== "ai-bad-request" &&
            backendCode !== "rate-limited",
        }),
      );
      expect(normalized.backendCode).toBe(backendCode);
      expect(normalized.code).not.toBe("unknown");
    }
  });
});
