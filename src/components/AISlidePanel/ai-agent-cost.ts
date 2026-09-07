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

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * Best-effort total-token count from one raw provider usage payload.
 * Returns 0 for missing, malformed, or empty usage rather than throwing, so a
 * provider that omits usage simply contributes nothing to the budget.
 */
export function extractAgentUsageTokens(
  usage: Record<string, unknown> | null | undefined,
): number {
  if (!usage || typeof usage !== "object") return 0;

  // Authoritative totals when the provider reports them directly.
  const explicitTotal =
    nonNegativeInteger(usage.total_tokens) || nonNegativeInteger(usage.totalTokenCount);
  if (explicitTotal > 0) return explicitTotal;

  // Otherwise sum the prompt/completion components across dialects.
  const prompt =
    nonNegativeInteger(usage.prompt_tokens)
    || nonNegativeInteger(usage.input_tokens)
    || nonNegativeInteger(usage.promptTokenCount);
  const completion =
    nonNegativeInteger(usage.completion_tokens)
    || nonNegativeInteger(usage.output_tokens)
    || nonNegativeInteger(usage.candidatesTokenCount);
  return prompt + completion;
}
