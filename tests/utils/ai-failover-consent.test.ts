import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAIFailoverConsent,
  isAIFailoverConsentPending,
  requestAIFailoverConsent,
  resolveAIFailoverConsent,
  setAIFailoverConsent,
} from "@/utils/ai-failover-consent";

describe("AI failover consent", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    if (isAIFailoverConsentPending()) resolveAIFailoverConsent(false);
  });

  it("defaults to unset and remembers decisions", () => {
    expect(getAIFailoverConsent()).toBe("unset");
    setAIFailoverConsent("approved");
    expect(getAIFailoverConsent()).toBe("approved");
    setAIFailoverConsent("declined");
    expect(getAIFailoverConsent()).toBe("declined");
  });

  it("resolves immediately from a remembered decision without asking", async () => {
    setAIFailoverConsent("approved");
    await expect(requestAIFailoverConsent()).resolves.toBe(true);
    setAIFailoverConsent("declined");
    await expect(requestAIFailoverConsent()).resolves.toBe(false);
    expect(isAIFailoverConsentPending()).toBe(false);
  });

  it("waits for the dialog decision when unset, then remembers the answer", async () => {
    const pending = requestAIFailoverConsent();
    expect(isAIFailoverConsentPending()).toBe(true);
    resolveAIFailoverConsent(true);
    await expect(pending).resolves.toBe(true);
    expect(getAIFailoverConsent()).toBe("approved");
    // Asked exactly once - later requests resolve from the stored decision.
    await expect(requestAIFailoverConsent()).resolves.toBe(true);
    expect(isAIFailoverConsentPending()).toBe(false);
  });

  it("records a decline so auto-switch stays off", async () => {
    const pending = requestAIFailoverConsent();
    resolveAIFailoverConsent(false);
    await expect(pending).resolves.toBe(false);
    expect(getAIFailoverConsent()).toBe("declined");
    await expect(requestAIFailoverConsent()).resolves.toBe(false);
  });
});