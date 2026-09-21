/**
 * Structured connection failure returned by the connect/test commands.
 * The backend classifies driver errors into a stage so the UI can show a
 * badge plus an actionable hint instead of a raw error blob.
 */
export type ConnectionErrorStage =
  "dns" | "tcp" | "tunnel" | "tls" | "auth" | "database" | "timeout" | "driver" | "unknown";

export interface ConnectionErrorDetails {
  stage: ConnectionErrorStage;
  message: string;
  hint: string;
}

const KNOWN_STAGES: Record<ConnectionErrorStage, true> = {
  dns: true,
  tcp: true,
  tunnel: true,
  tls: true,
  auth: true,
  database: true,
  timeout: true,
  driver: true,
  unknown: true,
};

/**
 * Normalize a rejected invoke value into `{stage, message, hint}`.
 * Tauri rejects with the serialized `ConnectionErrorInfo` object for the
 * connect/test commands, but plain strings and `Error` instances still arrive
 * from validation, timeouts, and older paths — all collapse to `unknown`.
 */
export function parseConnectionError(error: unknown): ConnectionErrorDetails {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const stage = typeof record.stage === "string" ? record.stage : null;
    const message =
      typeof record.message === "string" && record.message.trim()
        ? record.message
        : error instanceof Error
          ? error.message
          : String(error);
    const hint = typeof record.hint === "string" ? record.hint : "";
    return {
      stage:
        stage && KNOWN_STAGES[stage as ConnectionErrorStage]
          ? (stage as ConnectionErrorStage)
          : "unknown",
      message,
      hint,
    };
  }
  return { stage: "unknown", message: String(error), hint: "" };
}
