export type AIFailoverConsent = "unset" | "approved" | "declined";

const STORAGE_KEY = "tabler.ai.failoverConsent";
const CONSENT_REQUEST_EVENT = "ai-failover-consent-request";

let pendingResolver: ((approved: boolean) => void) | null = null;

export function getAIFailoverConsent(): AIFailoverConsent {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "approved" || raw === "declined" ? raw : "unset";
  } catch {
    return "unset";
  }
}

export function setAIFailoverConsent(value: "approved" | "declined"): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage can be unavailable (private mode); the decision then simply
    // lives for the current session via the pending resolver.
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
  return new Promise((resolve) => {
    pendingResolver = resolve;
    window.dispatchEvent(new CustomEvent(CONSENT_REQUEST_EVENT));
  });
}

export function resolveAIFailoverConsent(approved: boolean): void {
  setAIFailoverConsent(approved ? "approved" : "declined");
  const resolver = pendingResolver;
  pendingResolver = null;
  resolver?.(approved);
}