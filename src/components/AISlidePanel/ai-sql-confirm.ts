import type { AISqlConfirmationRequirement } from "./ai-execution-policy";
import { requestAppConfirmation } from "../../stores/confirmStore";

interface AISqlConfirmRequest {
  id: number;
  requirement: AISqlConfirmationRequirement;
  statements: string[];
}

interface AISqlConfirmResponse {
  id: number;
  approved: boolean;
}

const CONFIRM_REQUEST_EVENT = "ai-sql-confirm-request";
const CONFIRM_RESPONSE_EVENT = "ai-sql-confirm-response";

let requestSequence = 0;
/** Flipped by <AISqlConfirmDialog> so the helper knows a modal host exists. */
let isHostMounted = false;
/**
 * The single in-flight request. A second request replaces the dialog's state,
 * so the previous promise must be resolved (denied) here or it — and its
 * response listener — would leak forever.
 */
let pendingRequest: { id: number; resolve: (approved: boolean) => void } | null = null;

export function setAISqlConfirmHostMounted(mounted: boolean) {
  isHostMounted = mounted;
  // Host unmounted while a request was in flight: settle it as denied so the
  // waiting run unwinds instead of hanging on a dialog that no longer exists.
  denyPendingAISqlConfirmation();
}

/**
 * Resolves a pending confirmation as denied WITHOUT dispatching a response —
 * the dialog host may already be gone. Used when the run is cancelled or the
 * host unmounts, so the awaiting caller always settles.
 */
export function denyPendingAISqlConfirmation(): void {
  const pending = pendingRequest;
  pendingRequest = null;
  pending?.resolve(false);
}

/**
 * Ask the user to approve a mutating AI SQL run through the in-app dialog.
 * When no dialog host is mounted (e.g. the AI panel is closed) the request
 * goes through the app-wide ConfirmDialog — never the native window.confirm,
 * which is a no-op on macOS WKWebView and would silently approve nothing.
 * Read-only runs (`null` requirement) never need a dialog.
 */
export async function requestAISqlConfirmation(
  requirement: AISqlConfirmationRequirement,
  statements: string[],
): Promise<boolean> {
  if (requirement === null) return true;
  if (!isHostMounted) {
    const message =
      requirement === "high-risk"
        ? "The AI agent wants to run a high-risk SQL statement through the protected sandbox. It can apply real database changes. Approve this run?"
        : "The AI agent wants to run a write or schema-changing SQL statement through the sandbox. Approve this run?";
    return requestAppConfirmation({
      title: requirement === "high-risk" ? "Run high-risk SQL?" : "Run write SQL?",
      message,
      confirmText: "Run",
    });
  }

  const id = ++requestSequence;
  // A new request replaces the dialog's state; settle the previous one as
  // denied instead of orphaning its promise and listener forever.
  denyPendingAISqlConfirmation();
  return new Promise<boolean>((resolve) => {
    const handleResponse = (event: Event) => {
      const detail = (event as CustomEvent<AISqlConfirmResponse>).detail;
      if (detail.id !== id) return;
      window.removeEventListener(CONFIRM_RESPONSE_EVENT, handleResponse);
      if (pendingRequest?.id === id) pendingRequest = null;
      resolve(detail.approved);
    };
    pendingRequest = {
      id,
      resolve: (approved) => {
        window.removeEventListener(CONFIRM_RESPONSE_EVENT, handleResponse);
        resolve(approved);
      },
    };
    window.addEventListener(CONFIRM_RESPONSE_EVENT, handleResponse);
    window.dispatchEvent(
      new CustomEvent<AISqlConfirmRequest>(CONFIRM_REQUEST_EVENT, {
        detail: { id, requirement, statements },
      }),
    );
  });
}
