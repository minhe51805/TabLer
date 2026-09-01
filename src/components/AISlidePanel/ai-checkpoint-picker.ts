import type { AIDatabaseCheckpoint } from "./ai-slash-commands";

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

export function setAICheckpointPickerHostMounted(mounted: boolean) {
  isHostMounted = mounted;
}

/**
 * Ask the user to pick (and confirm) a DB checkpoint to roll back to.
 * Resolves the confirmed checkpoint's file name, or null when cancelled.
 * Falls back to a native confirm over the newest checkpoint when no modal
 * host is mounted (e.g. the AI panel is closed mid-flow).
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
    const message = language === "vi"
      ? `Khôi phục về checkpoint mới nhất "${newest.label}"? Dữ liệu hiện tại sẽ bị ghi đè.`
      : `Restore to the newest checkpoint "${newest.label}"? The current data will be overwritten.`;
    return window.confirm(message) ? newest.fileName : null;
  }

  const id = ++requestSequence;
  return new Promise<string | null>((resolve) => {
    const handleResponse = (event: Event) => {
      const detail = (event as CustomEvent<AICheckpointPickResponse>).detail;
      if (detail.id !== id) return;
      window.removeEventListener(PICK_RESPONSE_EVENT, handleResponse);
      resolve(detail.fileName);
    };
    window.addEventListener(PICK_RESPONSE_EVENT, handleResponse);
    window.dispatchEvent(
      new CustomEvent<AICheckpointPickRequest>(PICK_REQUEST_EVENT, {
        detail: { id, checkpoints, language, connectionId, dbType },
      }),
    );
  });
}
