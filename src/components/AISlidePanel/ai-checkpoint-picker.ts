import type { AIDatabaseCheckpoint } from "./ai-slash-commands";
import { requestAppConfirmation } from "../../stores/confirmStore";

export interface AICheckpointPickRequest {
  id: number;
  checkpoints: AIDatabaseCheckpoint[];
  language: string;
  /** Active connection — the modal needs it for the restore preview call. */
  connectionId: string | null;
  /** Engine type — required by the Rust preview/restore commands. */
  dbType: string;
}

interface AICheckpointPickResponse {
  id: number;
  /** File name of the confirmed checkpoint, or null when cancelled. */
  fileName: string | null;
}

const PICK_REQUEST_EVENT = "ai-checkpoint-pick-request";
const PICK_RESPONSE_EVENT = "ai-checkpoint-pick-response";

let requestSequence = 0;
/** Flipped by <AICheckpointPickerModal> so the helper knows a host exists. */
let isHostMounted = false;
/**
 * The single in-flight pick. A second request replaces the modal's state, so
 * the previous promise must be resolved (cancelled) here or it — and its
 * response listener — would leak forever.
 */
let pendingRequest: { id: number; resolve: (fileName: string | null) => void } | null = null;

export function setAICheckpointPickerHostMounted(mounted: boolean) {
  isHostMounted = mounted;
  // Host unmounted while a pick was in flight: settle it as cancelled so the
  // waiting run unwinds instead of hanging on a modal that no longer exists.
  denyPendingAICheckpointPick();
}

/**
 * Resolves a pending pick as cancelled WITHOUT dispatching a response — the
 * modal host may already be gone. Used when the run is cancelled or the host
 * unmounts, so the awaiting caller always settles.
 */
export function denyPendingAICheckpointPick(): void {
  const pending = pendingRequest;
  pendingRequest = null;
  pending?.resolve(null);
}

/**
 * Ask the user to pick (and confirm) a DB checkpoint to roll back to.
 * Resolves the confirmed checkpoint's file name, or null when cancelled.
 * When no modal host is mounted (e.g. the AI panel is closed mid-flow) the
 * newest checkpoint is offered through the app-wide ConfirmDialog — never
 * the native window.confirm (a no-op on macOS WKWebView).
 */
export async function requestAICheckpointPick(
  checkpoints: AIDatabaseCheckpoint[],
  language: string,
  connectionId: string | null,
  dbType: string,
): Promise<string | null> {
  if (checkpoints.length === 0) return null;
  if (!isHostMounted) {
    const newest = checkpoints[0];
    const approved = await requestAppConfirmation({
      title: language === "vi" ? "Khôi phục checkpoint?" : "Restore checkpoint?",
      message:
        language === "vi"
          ? `Khôi phục về checkpoint mới nhất "${newest.label}"? Dữ liệu hiện tại sẽ bị ghi đè.`
          : `Restore to the newest checkpoint "${newest.label}"? The current data will be overwritten.`,
      confirmText: language === "vi" ? "Khôi phục" : "Restore",
    });
    return approved ? newest.fileName : null;
  }

  const id = ++requestSequence;
  // A new request replaces the modal's state; settle the previous one as
  // cancelled instead of orphaning its promise and listener forever.
  denyPendingAICheckpointPick();
  return new Promise<string | null>((resolve) => {
    const handleResponse = (event: Event) => {
      const detail = (event as CustomEvent<AICheckpointPickResponse>).detail;
      if (detail.id !== id) return;
      window.removeEventListener(PICK_RESPONSE_EVENT, handleResponse);
      if (pendingRequest?.id === id) pendingRequest = null;
      resolve(detail.fileName);
    };
    pendingRequest = {
      id,
      resolve: (fileName) => {
        window.removeEventListener(PICK_RESPONSE_EVENT, handleResponse);
        resolve(fileName);
      },
    };
    window.addEventListener(PICK_RESPONSE_EVENT, handleResponse);
    window.dispatchEvent(
      new CustomEvent<AICheckpointPickRequest>(PICK_REQUEST_EVENT, {
        detail: { id, checkpoints, language, connectionId, dbType },
      }),
    );
  });
}
