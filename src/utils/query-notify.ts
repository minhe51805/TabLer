import { getCurrentAppLanguage } from "../i18n";
import { getQueryNotifyCopy } from "./query-notify-copy";

/**
 * Queries slower than this always raise a completion notification, even when
 * the window is focused — the user has likely switched their attention away.
 */
export const QUERY_NOTIFY_SLOW_MS = 10_000;

export interface QueryDoneDetails {
  /** Wall-clock duration of the execution attempt. */
  durationMs: number;
  /** Rows returned; used for the "N rows in Xs" body on success. */
  rowCount?: number;
  /** Set when the run failed; the notification shows the error instead. */
  error?: unknown;
}

let permissionRequest: Promise<"default" | "denied" | "granted"> | null = null;

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Fires an OS-level "query finished" notification when the user plausibly
 * missed the completion: the document was hidden, or the run took longer than
 * QUERY_NOTIFY_SLOW_MS. `@tauri-apps/plugin-notification` is not a dependency,
 * so this uses the WebView's Notification API; unsupported environments and
 * denied permission degrade to a no-op. Never throws.
 */
export async function notifyQueryDone(details: QueryDoneDetails): Promise<void> {
  const backgrounded = typeof document !== "undefined" && document.hidden === true;
  if (!backgrounded && details.durationMs <= QUERY_NOTIFY_SLOW_MS) return;
  if (typeof window === "undefined" || typeof Notification === "undefined") return;
  try {
    if (Notification.permission === "denied") return;
    if (Notification.permission === "default") {
      // One in-flight request at a time; a denial is remembered so we never
      // spam the permission prompt on every query.
      permissionRequest ??= Notification.requestPermission().catch(() => "denied" as const);
      if ((await permissionRequest) !== "granted") return;
    }
    const copy = getQueryNotifyCopy(getCurrentAppLanguage());
    const seconds = (details.durationMs / 1000).toFixed(1);
    const failed = details.error !== undefined;
    const title = failed ? copy.queryFailedTitle : copy.queryFinishedTitle;
    const body = failed
      ? copy.failedBody(errorToMessage(details.error), seconds)
      : copy.finishedBody(details.rowCount ?? 0, seconds);
    new Notification(title, { body });
  } catch {
    // Notification delivery is best-effort; never break the query path.
  }
}
