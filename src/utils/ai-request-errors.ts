export type AIRequestErrorCode =
  | "cancelled"
  | "timeout"
  | "provider"
  | "invalid-response"
  | "unknown";

export class AIRequestError extends Error {
  readonly code: AIRequestErrorCode;
  readonly retryable: boolean;

  constructor(code: AIRequestErrorCode, message: string, retryable = code !== "unknown") {
    super(message);
    this.name = "AIRequestError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function normalizeAIRequestError(errorValue: unknown) {
  if (errorValue instanceof AIRequestError) return errorValue;

  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  const normalized = message.toLowerCase();

  if (normalized.includes("cancelled") || normalized.includes("canceled")) {
    return new AIRequestError("cancelled", "AI request cancelled.");
  }
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return new AIRequestError("timeout", message);
  }
  if (
    normalized.includes("malformed json")
    || normalized.includes("non-json")
    || normalized.includes("invalid response")
    || normalized.includes("valid json")
  ) {
    return new AIRequestError("invalid-response", message);
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
    return new AIRequestError("provider", message);
  }

  return new AIRequestError("unknown", message, false);
}

export function isAIRequestErrorCode(errorValue: unknown, code: AIRequestErrorCode) {
  return normalizeAIRequestError(errorValue).code === code;
}
