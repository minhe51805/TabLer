import type { AISqlConfirmationRequirement } from "./ai-execution-policy";

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

export function setAISqlConfirmHostMounted(mounted: boolean) {
  isHostMounted = mounted;
}

/**
 * Ask the user to approve a mutating AI SQL run through the in-app dialog.
 * Falls back to the native window.confirm when no dialog host is mounted
 * (e.g. the AI panel is closed) so runs are never silently approved.
 * Read-only runs (`null` requirement) never need a dialog.
 */
export async function requestAISqlConfirmation(
  requirement: AISqlConfirmationRequirement,
  statements: string[],
): Promise<boolean> {
  if (requirement === null) return true;
  if (!isHostMounted) {
    const message = requirement === "high-risk"
      ? "The AI agent wants to run a high-risk SQL statement through the protected sandbox. It can apply real database changes. Approve this run?"
      : "The AI agent wants to run a write or schema-changing SQL statement through the sandbox. Approve this run?";
    return window.confirm(message);
  }

  const id = ++requestSequence;
  return new Promise<boolean>((resolve) => {
    const handleResponse = (event: Event) => {
      const detail = (event as CustomEvent<AISqlConfirmResponse>).detail;
      if (detail.id !== id) return;
      window.removeEventListener(CONFIRM_RESPONSE_EVENT, handleResponse);
      resolve(detail.approved);
    };
    window.addEventListener(CONFIRM_RESPONSE_EVENT, handleResponse);
    window.dispatchEvent(
      new CustomEvent<AISqlConfirmRequest>(CONFIRM_REQUEST_EVENT, {
        detail: { id, requirement, statements },
      }),
    );
  });
}
