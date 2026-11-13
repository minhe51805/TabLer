import { TauriCommandError, type TauriErrorCode } from "./tauri-error";

export type AIRequestErrorCode =
  "cancelled" | "timeout" | "provider" | "invalid-response" | "unknown";

export class AIRequestError extends Error {
  readonly code: AIRequestErrorCode;
  readonly retryable: boolean;
  /** Provider-advertised wait (Retry-After) in ms, when the error carries one. */
  readonly providerRetryAfterMs?: number;
  /** Exact structured backend `ErrorCode` when delivered via `TauriCommandError`. */
  readonly backendCode?: TauriErrorCode | string;

  constructor(
    code: AIRequestErrorCode,
    message: string,
    retryable = code !== "unknown",
    providerRetryAfterMs?: number,
    backendCode?: TauriErrorCode | string,
  ) {
    super(message);
    this.name = "AIRequestError";
    this.code = code;
    this.retryable = retryable;
    if (providerRetryAfterMs !== undefined) this.providerRetryAfterMs = providerRetryAfterMs;
    if (backendCode !== undefined) this.backendCode = backendCode;
  }
}

/** Legacy fallback: extract a `retry_after_ms=<n>` marker from plain-Error strings. */
function extractRetryAfterMs(message: string): number | undefined {
  const match = message.match(/retry_after_ms=(\d+)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function classifyStructuredCode(
  code: string,
  message: string,
  retryableHint: boolean | undefined,
  retryAfterMs: number | undefined,
): AIRequestError | undefined {
  switch (code) {
    case "ai-cancelled":
      return new AIRequestError("cancelled", "AI request cancelled.", true, retryAfterMs, code);
    case "ai-timeout":
      return new AIRequestError("timeout", message, true, retryAfterMs, code);
    case "ai-invalid-response":
      return new AIRequestError(
        "invalid-response",
        message,
        retryableHint ?? true,
        retryAfterMs,
        code,
      );
    case "ai-rate-limited":
    case "ai-provider-transient":
      return new AIRequestError("provider", message, retryableHint ?? true, retryAfterMs, code);
    case "ai-auth":
    case "ai-bad-request":
      // Auth (401/403) and bad-request (400/422) errors must NOT be retried against the same provider.
      return new AIRequestError("provider", message, false, undefined, code);
    case "rate-limited":
      // Local TableR rate limiter: retrying immediately only burns more attempts.
      return new AIRequestError("provider", message, false, retryAfterMs, code);
    case "validation-error":
    case "storage-error":
      return new AIRequestError("unknown", message, false, undefined, code);
    default:
      return undefined;
  }
}

export function normalizeAIRequestError(errorValue: unknown): AIRequestError {
  if (errorValue instanceof AIRequestError) return errorValue;

  // Prefer structured `TauriCommandError` (or raw IPC `{ code, message, retryable, retryAfterMs }`).
  if (errorValue instanceof TauriCommandError) {
    const mapped = classifyStructuredCode(
      errorValue.code,
      errorValue.message,
      errorValue.retryable,
      errorValue.retryAfterMs ?? extractRetryAfterMs(errorValue.message),
    );
    if (mapped) return mapped;
  } else if (errorValue && typeof errorValue === "object" && "code" in errorValue) {
    const rec = errorValue as {
      code?: unknown;
      message?: unknown;
      retryable?: unknown;
      retryAfterMs?: unknown;
    };
    if (typeof rec.code === "string" && typeof rec.message === "string") {
      const mapped = classifyStructuredCode(
        rec.code,
        rec.message,
        typeof rec.retryable === "boolean" ? rec.retryable : undefined,
        typeof rec.retryAfterMs === "number" ? rec.retryAfterMs : extractRetryAfterMs(rec.message),
      );
      if (mapped) return mapped;
    }
  }

  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  const providerRetryAfterMs = extractRetryAfterMs(message);
  const normalized = message.toLowerCase();

  if (normalized.includes("cancelled") || normalized.includes("canceled")) {
    return new AIRequestError("cancelled", "AI request cancelled.", true, providerRetryAfterMs);
  }
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return new AIRequestError("timeout", message, true, providerRetryAfterMs);
  }
  if (
    normalized.includes("malformed json") ||
    normalized.includes("non-json") ||
    normalized.includes("invalid response") ||
    normalized.includes("valid json")
  ) {
    return new AIRequestError("invalid-response", message, true, providerRetryAfterMs);
  }
  if (normalized.includes("too many ai requests")) {
    return new AIRequestError("provider", message, false, providerRetryAfterMs, "rate-limited");
  }
  if (
    normalized.includes("provider") ||
    normalized.includes("ai api") ||
    normalized.includes("api key") ||
    normalized.includes("rate limit") ||
    normalized.includes("network") ||
    normalized.includes("connection") ||
    normalized.includes("http ") ||
    normalized.includes("status ")
  ) {
    return new AIRequestError("provider", message, true, providerRetryAfterMs);
  }

  return new AIRequestError("unknown", message, false, providerRetryAfterMs);
}
