export type AIFailoverConsent = "unset" | "approved" | "declined";

const STORAGE_KEY = "tabler.ai.failoverConsent";
const CONSENT_REQUEST_EVENT = "ai-failover-consent-request";

let pendingResolver: ((approved: boolean) => void) | null = null;
let pendingTimer: number | null = null;

/**
 * How long an unanswered consent request may hold a caller. The dialog only
 * exists while the AI panel is open, so a request that outlives this window
 * is almost certainly one nobody can see — resolving it as denied keeps a
 * scheduled run from starving the queue forever.
 */
const CONSENT_TIMEOUT_MS = 60_000;

function clearPending() {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  pendingResolver = null;
}

export function getAIFailoverConsent(): AIFailoverConsent {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "approved" || raw === "declined" ? raw : "unset";
  } catch (error) {
    console.warn("[AI] Failed to read failover consent:", error);
    return "unset";
  }
}

export function setAIFailoverConsent(value: "approved" | "declined"): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch (error) {
    // Storage can be unavailable (private mode); the decision then simply
    // lives for the current session via the pending resolver.
    console.warn("[AI] Failed to persist failover consent:", error);
  }
  window.dispatchEvent(new CustomEvent("ai-failover-consent-change"));
}

export function isAIFailoverConsentPending(): boolean {
  return pendingResolver !== null;
}

/**
 * Asks the user once for permission to auto-failover. Resolves immediately
 * when a decision was already remembered; otherwise fires the request event
 * the panel listens on and waits for resolveAIFailoverConsent.
 */
export function requestAIFailoverConsent(): Promise<boolean> {
  const current = getAIFailoverConsent();
  if (current !== "unset") return Promise.resolve(current === "approved");
  if (pendingResolver) return Promise.resolve(false);
  // Executor form: Promise.withResolvers is unavailable under the project's
  // ES2020 lib target.
  return new Promise<boolean>((resolve) => {
    pendingResolver = resolve;
    pendingTimer = window.setTimeout(() => {
      // Nobody answered in time — treat as denied without remembering, so the
      // question can be asked again when a human is actually present.
      clearPending();
      resolve(false);
    }, CONSENT_TIMEOUT_MS);
    window.dispatchEvent(new CustomEvent(CONSENT_REQUEST_EVENT));
  });
}

export function resolveAIFailoverConsent(approved: boolean): void {
  setAIFailoverConsent(approved ? "approved" : "declined");
  const resolver = pendingResolver;
  clearPending();
  resolver?.(approved);
}

/**
 * Resolves a pending consent request as denied WITHOUT remembering the
 * decision — closing the panel is not a user choice, so the question may be
 * asked again later. Releases callers (e.g. scheduled runs) that would
 * otherwise wait forever on a dialog nobody can see.
 */
export function denyPendingAIFailoverConsent(): void {
  const resolver = pendingResolver;
  clearPending();
  resolver?.(false);
}
