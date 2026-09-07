import type { AIRequestErrorCode } from "../../utils/ai-request-errors";

/**
 * Retry policy for agent model calls (scoped adaptation of deepseek-harness
 * `llm-retry`): bounded retry count, exponential backoff with jitter, and
 * honoring the provider's own Retry-After window when it advertises one.
 *
 * Deliberately NOT a full backoff-forever policy: each attempt already walks
 * the provider failover chain internally, and step/token budgets bound the
 * run — the policy only smooths transient spikes (429, blips).
 */
export interface AgentRetryPolicy {
  /** Retry attempts per askAI call after the first failure. */
  maxRetries: number;
  /** Base delay for the exponential backoff (attempt 1). */
  initialDelayMs: number;
  /** Ceiling for the computed backoff delay. */
  maxDelayMs: number;
  /** ± fraction applied to the computed delay (0 = deterministic). */
  jitterRatio: number;
  /** Longest provider-advertised wait we honor in-line; longer → give up. */
  maxRetryWaitMs: number;
  /** Error codes eligible for in-line retry; others fail straight through. */
  retryableCodes: AIRequestErrorCode[];
}

export const DEFAULT_AGENT_RETRY_POLICY: AgentRetryPolicy = {
  maxRetries: 2,
  initialDelayMs: 800,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
  maxRetryWaitMs: 30_000,
  retryableCodes: ["timeout", "provider"],
};

export interface ComputeRetryDelayInput {
  /** 1-based attempt number that just failed (1 = first failure). */
  retry: number;
  policy: AgentRetryPolicy;
  /** True when the failure message looks like a rate limit (429/quota). */
  rateLimited: boolean;
  /** Provider-advertised wait, when the failure carried a Retry-After marker. */
  providerRetryAfterMs?: number;
  /** Random sample in [0, 1]; injectable for deterministic tests. */
  random: () => number;
}

/**
 * Delay before the next attempt, or `null` when the policy says NOT to retry
 * in-line: a rate-limited provider that asks for a wait longer than
 * `maxRetryWaitMs` should hand control to the failover/recovery layers
 * instead of stalling the step for minutes (deepseek-harness semantics).
 */
export function computeAgentRetryDelay(input: ComputeRetryDelayInput): number | null {
  const { retry, policy, rateLimited, providerRetryAfterMs, random } = input;
  if (rateLimited && providerRetryAfterMs !== undefined) {
    if (providerRetryAfterMs > policy.maxRetryWaitMs) return null;
    return providerRetryAfterMs;
  }
  const exponent = Math.min(Math.max(retry - 1, 0), 16);
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs);
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random();
  return Math.round(Math.min(exponential * jitter, policy.maxDelayMs));
}
