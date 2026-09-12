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

/**
 * Machine-readable classification the Rust AI layer appends to its error
 * messages (`src-tauri/src/commands/ai/errors.rs`). The shared contract (marker
 * key + the set of kinds) lives in `tests/fixtures/ai-error-kinds.json`.
 */
export const AI_ERROR_KIND_MARKER_KEY = "ai_error_kind";
const AI_ERROR_KIND_PATTERN = new RegExp(`\\s*\\[${AI_ERROR_KIND_MARKER_KEY}=([a-z-]+)\\]`, "i");

const KNOWN_AI_REQUEST_ERROR_CODES: readonly AIRequestErrorCode[] = [
  "cancelled",
  "timeout",
  "provider",
  "invalid-response",
  "unknown",
];

function asAIRequestErrorCode(value: string): AIRequestErrorCode | undefined {
  return (KNOWN_AI_REQUEST_ERROR_CODES as readonly string[]).includes(value)
    ? (value as AIRequestErrorCode)
    : undefined;
}

/**
 * Splits a backend AI error message into its authoritative `kind` marker (when
 * present) and the human-facing text with the marker removed, so the marker
 * never reaches the user.
 */
function splitTaggedKind(message: string): { code?: AIRequestErrorCode; message: string } {
  const match = message.match(AI_ERROR_KIND_PATTERN);
  if (!match) return { message };
  const stripped = message.replace(AI_ERROR_KIND_PATTERN, "").trim();
  return { code: asAIRequestErrorCode(match[1].toLowerCase()), message: stripped };
}

export function normalizeAIRequestError(errorValue: unknown) {
  if (errorValue instanceof AIRequestError) return errorValue;

  const rawMessage = errorValue instanceof Error ? errorValue.message : String(errorValue);
  const providerRetryAfterMs = extractRetryAfterMs(rawMessage);

  // Prefer the backend's authoritative kind marker over fragile substring
  // guessing (tech-debt D7). The heuristics below remain the fallback for
  // untagged failures: client-side timeouts, rate-limit/config errors, and any
  // non-provider path that never gets tagged.
  const tagged = splitTaggedKind(rawMessage);
  if (tagged.code) {
    if (tagged.code === "cancelled") {
      return new AIRequestError("cancelled", "AI request cancelled.", true, providerRetryAfterMs);
    }
    return new AIRequestError(
      tagged.code,
      tagged.message,
      tagged.code !== "unknown",
      providerRetryAfterMs,
    );
  }

  const message = tagged.message;
  const normalized = message.toLowerCase();

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
