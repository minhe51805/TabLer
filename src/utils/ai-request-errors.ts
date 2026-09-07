export type AIRequestErrorCode =
  | "cancelled"
  | "timeout"
  | "provider"
  | "invalid-response"
  | "unknown";

export class AIRequestError extends Error {
  readonly code: AIRequestErrorCode;
  readonly retryable: boolean;
  /** Provider-advertised wait (Retry-After) in ms, when the error carries one. */
  readonly providerRetryAfterMs?: number;

  constructor(
    code: AIRequestErrorCode,
    message: string,
    retryable = code !== "unknown",
    providerRetryAfterMs?: number,
  ) {
    super(message);
    this.name = "AIRequestError";
    this.code = code;
    this.retryable = retryable;
    if (providerRetryAfterMs !== undefined) this.providerRetryAfterMs = providerRetryAfterMs;
  }
}

/** Extract a `retry_after_ms=<n>` marker from a provider error message. */
function extractRetryAfterMs(message: string): number | undefined {
  const match = message.match(/retry_after_ms=(\d+)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function normalizeAIRequestError(errorValue: unknown) {
  if (errorValue instanceof AIRequestError) return errorValue;

  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  const normalized = message.toLowerCase();
  const providerRetryAfterMs = extractRetryAfterMs(message);

  if (normalized.includes("cancelled") || normalized.includes("canceled")) {
    return new AIRequestError("cancelled", "AI request cancelled.", true, providerRetryAfterMs);
  }
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return new AIRequestError("timeout", message, true, providerRetryAfterMs);
  }
  if (
    normalized.includes("malformed json")
    || normalized.includes("non-json")
    || normalized.includes("invalid response")
    || normalized.includes("valid json")
  ) {
    return new AIRequestError("invalid-response", message, true, providerRetryAfterMs);
  }
  if (
    normalized.includes("provider")
    || normalized.includes("ai api")
    || normalized.includes("api key")
    || normalized.includes("rate limit")
    || normalized.includes("too many ai requests")
    || normalized.includes("network")
    || normalized.includes("connection")
    || normalized.includes("http ")
    || normalized.includes("status ")
  ) {
    return new AIRequestError("provider", message, true, providerRetryAfterMs);
  }

  return new AIRequestError("unknown", message, false, providerRetryAfterMs);
}

export function isAIRequestErrorCode(errorValue: unknown, code: AIRequestErrorCode) {
  return normalizeAIRequestError(errorValue).code === code;
}
