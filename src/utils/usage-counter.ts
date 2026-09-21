/**
 * Local-only usage counter: a single JSON blob in localStorage that counts how
 * often each feature surface is opened or run. No network, no identifiers —
 * the About modal renders the raw counts so a user can paste them into a bug
 * report and tell us which features actually get used.
 */

const STORAGE_KEY = "tabler.usage-counters.v1";

/** Feature keys we count. Keep names stable — they are the stored data. */
export const USAGE_FEATURES = [
  "modal.about",
  "modal.aiSettings",
  "modal.pluginManager",
  "modal.mcpIntegrations",
  "modal.userRoles",
  "modal.shortcuts",
  "modal.themeCustomizer",
  "modal.connectionExporter",
  "modal.connectionImporter",
  "modal.diagnostics",
  "export.file",
  "agent.run",
  "chart.open",
  "diff.schema",
  "diff.result",
] as const;

export type UsageFeature = (typeof USAGE_FEATURES)[number];

export type UsageCounters = Partial<Record<UsageFeature, number>>;

/** Snapshot of all counters, ordered by the declared feature list. */
export function getUsageCounters(): UsageCounters {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const counters: UsageCounters = {};
    for (const feature of USAGE_FEATURES) {
      const value = (parsed as Record<string, unknown>)[feature];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        counters[feature] = Math.floor(value);
      }
    }
    return counters;
  } catch {
    // Corrupt or unavailable storage must never break a feature open.
    return {};
  }
}

/** Increment the counter for one feature use. Silently no-ops without storage. */
export function trackUsage(feature: UsageFeature): void {
  try {
    const counters = getUsageCounters();
    counters[feature] = (counters[feature] ?? 0) + 1;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(counters));
  } catch {
    // Private-mode / quota errors: usage stats are best-effort only.
  }
}
