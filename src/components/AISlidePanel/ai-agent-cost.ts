/**
 * Provider-agnostic token accounting for the agent tool loop.
 *
 * The backend forwards each provider's raw usage payload unchanged
 * (`ask_ai_stream` -> "usage" event), so the key names differ per dialect:
 *   - OpenAI / OpenRouter / Custom: { prompt_tokens, completion_tokens, total_tokens }
 *   - Anthropic:                    { input_tokens, output_tokens }
 *   - Gemini (usageMetadata):       { promptTokenCount, candidatesTokenCount, totalTokenCount }
 *
 * This helper normalizes those into a single non-negative integer so the
 * runner can enforce one cost ceiling regardless of the active provider.
 */

/** Default ceiling on cumulative agent tokens before the loop must finish. */
export const DEFAULT_AGENT_TOKEN_BUDGET = 120_000;

/**
 * Context-compaction trigger: once a run's cumulative spend crosses ~70% of
 * the token budget, older trace steps are folded into an "Earlier context"
 * summary so subsequent prompts stay small instead of hitting the wall.
 */
export const AGENT_COMPACTION_TOKEN_THRESHOLD = Math.floor(DEFAULT_AGENT_TOKEN_BUDGET * 0.7);

/** Trace steps always replayed verbatim at the tail; only older ones fold. */
export const AGENT_COMPACTION_KEEP_TAIL = 3;

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Best-effort total-token count from one raw provider usage payload.
 * Returns 0 for missing, malformed, or empty usage rather than throwing, so a
 * provider that omits usage simply contributes nothing to the budget.
 */
export function extractAgentUsageTokens(usage: Record<string, unknown> | null | undefined): number {
  if (!usage || typeof usage !== "object") return 0;

  // Authoritative totals when the provider reports them directly.
  const explicitTotal =
    nonNegativeInteger(usage.total_tokens) || nonNegativeInteger(usage.totalTokenCount);
  if (explicitTotal > 0) return explicitTotal;

  // Otherwise sum the prompt/completion components across dialects.
  const prompt =
    nonNegativeInteger(usage.prompt_tokens) ||
    nonNegativeInteger(usage.input_tokens) ||
    nonNegativeInteger(usage.promptTokenCount);
  const completion =
    nonNegativeInteger(usage.completion_tokens) ||
    nonNegativeInteger(usage.output_tokens) ||
    nonNegativeInteger(usage.candidatesTokenCount);
  return prompt + completion;
}

/** Prompt/completion split of one provider usage payload (0 when unreported). */
export interface AgentUsageBreakdown {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Component-level token counts from one raw provider usage payload. Mirrors
 * the dialect handling of {@link extractAgentUsageTokens} but keeps the
 * prompt/completion split so cost estimates can price input and output at
 * their own rates.
 */
export function extractAgentUsageBreakdown(
  usage: Record<string, unknown> | null | undefined,
): AgentUsageBreakdown {
  if (!usage || typeof usage !== "object") {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  const prompt =
    nonNegativeInteger(usage.prompt_tokens) ||
    nonNegativeInteger(usage.input_tokens) ||
    nonNegativeInteger(usage.promptTokenCount);
  const completion =
    nonNegativeInteger(usage.completion_tokens) ||
    nonNegativeInteger(usage.output_tokens) ||
    nonNegativeInteger(usage.candidatesTokenCount);
  const explicitTotal =
    nonNegativeInteger(usage.total_tokens) || nonNegativeInteger(usage.totalTokenCount);
  // Prefer the provider's own total; fall back to the component sum.
  const totalTokens = explicitTotal > 0 ? explicitTotal : prompt + completion;
  return { promptTokens: prompt, completionTokens: completion, totalTokens };
}

/**
 * Rough public list prices, USD per 1k tokens (input/output), as of late 2025.
 * This table is an estimate aid, not a billing source — unknown models report
 * no rate and the UI shows "n/a" for their cost share.
 *
 * `match` is compared against the normalized model id (lowercase, provider
 * prefix like "openai/" and date suffixes like "-2024-08-06" stripped) with a
 * prefix test; the longest matching entry wins.
 */
const MODEL_TOKEN_RATES: { match: string; inputPer1k: number; outputPer1k: number }[] = [
  // OpenAI
  { match: "gpt-5-pro", inputPer1k: 0.015, outputPer1k: 0.12 },
  { match: "gpt-5-mini", inputPer1k: 0.00025, outputPer1k: 0.002 },
  { match: "gpt-5-nano", inputPer1k: 0.00005, outputPer1k: 0.0004 },
  { match: "gpt-5", inputPer1k: 0.00125, outputPer1k: 0.01 },
  { match: "gpt-4.1-mini", inputPer1k: 0.0004, outputPer1k: 0.0016 },
  { match: "gpt-4.1-nano", inputPer1k: 0.0001, outputPer1k: 0.0004 },
  { match: "gpt-4.1", inputPer1k: 0.002, outputPer1k: 0.008 },
  { match: "gpt-4o-mini", inputPer1k: 0.00015, outputPer1k: 0.0006 },
  { match: "gpt-4o", inputPer1k: 0.0025, outputPer1k: 0.01 },
  { match: "gpt-4-turbo", inputPer1k: 0.01, outputPer1k: 0.03 },
  { match: "gpt-4", inputPer1k: 0.03, outputPer1k: 0.06 },
  { match: "gpt-3.5-turbo", inputPer1k: 0.0005, outputPer1k: 0.0015 },
  { match: "o4-mini", inputPer1k: 0.0011, outputPer1k: 0.0044 },
  { match: "o3-mini", inputPer1k: 0.0011, outputPer1k: 0.0044 },
  { match: "o3-pro", inputPer1k: 0.02, outputPer1k: 0.08 },
  { match: "o3", inputPer1k: 0.002, outputPer1k: 0.008 },
  { match: "o1-mini", inputPer1k: 0.0011, outputPer1k: 0.0044 },
  { match: "o1-pro", inputPer1k: 0.15, outputPer1k: 0.6 },
  { match: "o1", inputPer1k: 0.015, outputPer1k: 0.06 },
  // Anthropic
  { match: "claude-opus-4-1", inputPer1k: 0.015, outputPer1k: 0.075 },
  { match: "claude-opus-4", inputPer1k: 0.015, outputPer1k: 0.075 },
  { match: "claude-sonnet-4-5", inputPer1k: 0.003, outputPer1k: 0.015 },
  { match: "claude-sonnet-4", inputPer1k: 0.003, outputPer1k: 0.015 },
  { match: "claude-haiku-4-5", inputPer1k: 0.001, outputPer1k: 0.005 },
  { match: "claude-3-7-sonnet", inputPer1k: 0.003, outputPer1k: 0.015 },
  { match: "claude-3-5-sonnet", inputPer1k: 0.003, outputPer1k: 0.015 },
  { match: "claude-3-5-haiku", inputPer1k: 0.0008, outputPer1k: 0.004 },
  { match: "claude-3-opus", inputPer1k: 0.015, outputPer1k: 0.075 },
  { match: "claude-3-sonnet", inputPer1k: 0.003, outputPer1k: 0.015 },
  { match: "claude-3-haiku", inputPer1k: 0.00025, outputPer1k: 0.00125 },
  // Google
  { match: "gemini-2.5-pro", inputPer1k: 0.00125, outputPer1k: 0.01 },
  { match: "gemini-2.5-flash-lite", inputPer1k: 0.0001, outputPer1k: 0.0004 },
  { match: "gemini-2.5-flash", inputPer1k: 0.0003, outputPer1k: 0.0025 },
  { match: "gemini-2.0-flash-lite", inputPer1k: 0.000075, outputPer1k: 0.0003 },
  { match: "gemini-2.0-flash", inputPer1k: 0.0001, outputPer1k: 0.0004 },
  { match: "gemini-1.5-pro", inputPer1k: 0.00125, outputPer1k: 0.005 },
  { match: "gemini-1.5-flash", inputPer1k: 0.000075, outputPer1k: 0.0003 },
  // DeepSeek
  { match: "deepseek-reasoner", inputPer1k: 0.00055, outputPer1k: 0.00219 },
  { match: "deepseek-chat", inputPer1k: 0.00027, outputPer1k: 0.0011 },
  { match: "deepseek-v3", inputPer1k: 0.00027, outputPer1k: 0.0011 },
  { match: "deepseek-r1", inputPer1k: 0.00055, outputPer1k: 0.00219 },
  // Mistral
  { match: "mistral-large", inputPer1k: 0.002, outputPer1k: 0.006 },
  { match: "mistral-small", inputPer1k: 0.0001, outputPer1k: 0.0003 },
  { match: "codestral", inputPer1k: 0.0003, outputPer1k: 0.0009 },
  // xAI
  { match: "grok-4", inputPer1k: 0.003, outputPer1k: 0.015 },
  { match: "grok-3-mini", inputPer1k: 0.0003, outputPer1k: 0.0005 },
  { match: "grok-3", inputPer1k: 0.003, outputPer1k: 0.015 },
  { match: "grok-2", inputPer1k: 0.002, outputPer1k: 0.01 },
  // Meta (hosted list price, e.g. via OpenRouter/Groq)
  { match: "llama-3.3-70b", inputPer1k: 0.00012, outputPer1k: 0.0003 },
  { match: "llama-3.1-405b", inputPer1k: 0.003, outputPer1k: 0.003 },
  { match: "llama-3.1-70b", inputPer1k: 0.00035, outputPer1k: 0.0004 },
  { match: "llama-3.1-8b", inputPer1k: 0.000055, outputPer1k: 0.000055 },
];

/**
 * Normalize a provider-reported model id for rate lookup: lowercase, drop the
 * "vendor/" routing prefix (OpenRouter), the "models/" prefix (Gemini), the
 * "ft:" fine-tune marker, OpenRouter ":suffix" tags, and trailing date stamps.
 */
function normalizeModelIdForPricing(model: string): string {
  let id = model.trim().toLowerCase();
  if (id.startsWith("ft:")) id = id.slice(3);
  const colonIndex = id.indexOf(":");
  if (colonIndex > 0) id = id.slice(0, colonIndex);
  const slashIndex = id.lastIndexOf("/");
  if (slashIndex >= 0) id = id.slice(slashIndex + 1);
  if (id.startsWith("models/")) id = id.slice(7);
  // Strip trailing date/version stamps: "-2024-08-06", "-20250514", "@20241022".
  id = id.replace(/[-@]\d{4}-\d{2}-\d{2}$/, "").replace(/[-@]\d{8}$/, "");
  return id;
}

/** Per-1k USD rates for a model id, or null when the model is not priced. */
export function lookupModelTokenRates(
  model: string | null | undefined,
): { inputPer1k: number; outputPer1k: number } | null {
  if (!model) return null;
  const normalized = normalizeModelIdForPricing(model);
  if (!normalized) return null;
  let best: { match: string; inputPer1k: number; outputPer1k: number } | null = null;
  for (const rate of MODEL_TOKEN_RATES) {
    if (!normalized.startsWith(rate.match)) continue;
    if (!best || rate.match.length > best.match.length) best = rate;
  }
  return best ? { inputPer1k: best.inputPer1k, outputPer1k: best.outputPer1k } : null;
}

/**
 * Estimated USD cost of one usage breakdown at the model's list rates. When
 * the prompt/completion split is unknown, the mean of the two rates prices the
 * total — a rough figure, which is all this table promises. Returns null when
 * the model has no known rate.
 */
export function estimateUsageCostUsd(
  model: string | null | undefined,
  usage: AgentUsageBreakdown,
): number | null {
  const rates = lookupModelTokenRates(model);
  if (!rates || usage.totalTokens <= 0) return null;
  if (usage.promptTokens > 0 || usage.completionTokens > 0) {
    return (
      (usage.promptTokens / 1000) * rates.inputPer1k +
      (usage.completionTokens / 1000) * rates.outputPer1k
    );
  }
  const blended = (rates.inputPer1k + rates.outputPer1k) / 2;
  return (usage.totalTokens / 1000) * blended;
}

/** One provider/model pair's cumulative session spend. */
export interface SessionModelUsageEntry {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  /** Sum of per-call estimates; null when the model has no known rate. */
  estimatedCostUsd: number | null;
}

export interface SessionUsageSnapshot {
  totalTokens: number;
  totalCalls: number;
  /** Null only when nothing is priced; partial coverage still yields a number. */
  estimatedCostUsd: number | null;
  /** True when at least one entry has no known rate (estimate is a floor). */
  hasUnpriced: boolean;
  entries: SessionModelUsageEntry[];
}

const sessionUsageEntries = new Map<string, SessionModelUsageEntry>();
const sessionUsageListeners = new Set<() => void>();
let sessionUsageSnapshotCache: SessionUsageSnapshot | null = null;

function notifySessionUsageListeners() {
  sessionUsageSnapshotCache = null;
  for (const listener of sessionUsageListeners) listener();
}

/**
 * Add one completed model call to the session total. Calls with no reported
 * usage still count toward `calls` so the summary reflects real activity.
 */
export function recordSessionModelUsage(
  provider: string,
  model: string,
  usage: AgentUsageBreakdown,
): void {
  const providerLabel = provider.trim() || "unknown";
  const modelLabel = model.trim() || "unknown";
  const key = `${providerLabel}${modelLabel}`;
  const existing = sessionUsageEntries.get(key);
  const callCost = estimateUsageCostUsd(modelLabel, usage);
  const entry: SessionModelUsageEntry = existing
    ? {
        ...existing,
        promptTokens: existing.promptTokens + usage.promptTokens,
        completionTokens: existing.completionTokens + usage.completionTokens,
        totalTokens: existing.totalTokens + usage.totalTokens,
        calls: existing.calls + 1,
        estimatedCostUsd:
          existing.estimatedCostUsd === null && callCost === null
            ? null
            : (existing.estimatedCostUsd ?? 0) + (callCost ?? 0),
      }
    : {
        provider: providerLabel,
        model: modelLabel,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        calls: 1,
        estimatedCostUsd: callCost,
      };
  sessionUsageEntries.set(key, entry);
  notifySessionUsageListeners();
}

/** Current session totals; the same object is returned until usage changes. */
export function getSessionUsageSnapshot(): SessionUsageSnapshot {
  if (sessionUsageSnapshotCache) return sessionUsageSnapshotCache;
  const entries = [...sessionUsageEntries.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  let totalTokens = 0;
  let totalCalls = 0;
  let estimatedCostUsd = 0;
  let hasPriced = false;
  let hasUnpriced = false;
  for (const entry of entries) {
    totalTokens += entry.totalTokens;
    totalCalls += entry.calls;
    if (entry.estimatedCostUsd === null) {
      hasUnpriced = true;
    } else {
      hasPriced = true;
      estimatedCostUsd += entry.estimatedCostUsd;
    }
  }
  sessionUsageSnapshotCache = {
    totalTokens,
    totalCalls,
    estimatedCostUsd: hasPriced ? estimatedCostUsd : null,
    hasUnpriced,
    entries,
  };
  return sessionUsageSnapshotCache;
}

/** useSyncExternalStore subscribe hook for the session usage snapshot. */
export function subscribeSessionUsage(listener: () => void): () => void {
  sessionUsageListeners.add(listener);
  return () => {
    sessionUsageListeners.delete(listener);
  };
}

/** Reset the session totals (panel remounts keep history; tests need this). */
export function resetSessionUsage(): void {
  sessionUsageEntries.clear();
  notifySessionUsageListeners();
}

/** Compact USD label: "<$0.01" under a cent, else two decimals. */
export function formatSessionCostUsd(costUsd: number): string {
  if (costUsd <= 0) return "$0.00";
  if (costUsd < 0.01) return "<$0.01";
  return `$${costUsd.toFixed(2)}`;
}
