export type TauriErrorCode =
  | "connection-not-found"
  | "connection-error"
  | "query-error"
  | "query-cancelled"
  | "query-timeout"
  | "validation-error"
  | "storage-error"
  | "rate-limited"
  | "sandbox-denied"
  | "sandbox-throttled"
  | "safe-mode-blocked"
  | "ai-cancelled"
  | "ai-timeout"
  | "ai-auth"
  | "ai-bad-request"
  | "ai-rate-limited"
  | "ai-provider-transient"
  | "ai-invalid-response"
  | "internal";

export interface TauriErrorPayload {
  code?: TauriErrorCode | string;
  message: string;
  retryable?: boolean;
  retryAfterMs?: number;
  stage?: string;
  hint?: string;
}

export class TauriCommandError extends Error {
  readonly code: TauriErrorCode | string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly stage?: string;
  readonly hint?: string;

  constructor(payload: TauriErrorPayload) {
    super(payload.message);
    this.name = "TauriCommandError";
    this.code = payload.code ?? "internal";
    this.retryable = payload.retryable ?? false;
    if (payload.retryAfterMs !== undefined) this.retryAfterMs = payload.retryAfterMs;
    if (payload.stage !== undefined) this.stage = payload.stage;
    if (payload.hint !== undefined) this.hint = payload.hint;
  }
}

export class TauriTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TauriTimeoutError";
  }
}

/**
 * Normalizes any Tauri IPC rejection (structured `{ code, message, retryable, retryAfterMs }`
 * from Rust `AppError`, legacy `ConnectionErrorInfo`, plain strings, or mocked `Error`s)
 * into a standard `Error` instance so `err instanceof Error` and `err.message` always hold.
 */
export function toTauriCommandError(error: unknown): Error {
  if (error instanceof TauriCommandError || error instanceof TauriTimeoutError) {
    return error;
  }
  if (error instanceof Error) {
    return error;
  }
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    const message =
      typeof rec.message === "string"
        ? rec.message
        : typeof rec.error === "string"
          ? rec.error
          : JSON.stringify(error);
    const code =
      typeof rec.code === "string"
        ? rec.code
        : typeof rec.stage === "string"
          ? "connection-error"
          : "internal";
    return new TauriCommandError({
      code,
      message,
      retryable: typeof rec.retryable === "boolean" ? rec.retryable : false,
      retryAfterMs:
        typeof rec.retryAfterMs === "number" && Number.isFinite(rec.retryAfterMs)
          ? rec.retryAfterMs
          : undefined,
      stage: typeof rec.stage === "string" ? rec.stage : undefined,
      hint: typeof rec.hint === "string" ? rec.hint : undefined,
    });
  }
  return new TauriCommandError({
    code: "internal",
    message: String(error),
    retryable: false,
  });
}
