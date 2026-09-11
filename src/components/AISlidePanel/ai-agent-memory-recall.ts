/**
 * ai-agent-memory-recall — relevance ranking for the agent memory index.
 *
 * The controller prompt carries a frontmatter-only memory index (name +
 * description + freshness) for the current (connection, database) scope. Left
 * in storage order the agent often overlooks the ONE memory that answers the
 * current question. This module scores each index entry against the user's
 * prompt so the most relevant memories are surfaced FIRST and explicitly
 * flagged, nudging the agent to `read_memory` them before spending tool steps
 * rediscovering facts it already saved.
 *
 * The scoring is deliberately lexical and deterministic (no embeddings, no
 * clock): qualified identifiers (`dbo.taikhoan`) and snake_case handles are the
 * strongest signals — they mirror how `extractMemoryKeywords` builds a memory's
 * searchable handles — followed by plain word overlap. Identical inputs always
 * yield the identical ranking, so the behavior is unit-testable.
 */

/** Structural shape of an agent-memory index entry (matches use-agent-memory). */
export interface AgentMemoryRecallEntry {
  name: string;
  description: string;
  updatedAt: string;
}

export interface RankedAgentMemory {
  entry: AgentMemoryRecallEntry;
  score: number;
  /** True when the entry clears the relevance threshold for the prompt. */
  relevant: boolean;
}

/** A memory is "relevant" once it accumulates at least this much overlap score. */
export const MEMORY_RECALL_RELEVANCE_THRESHOLD = 3;

/** Common words that carry no recall signal (kept small; identifiers matter more). */
const RECALL_STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "have", "has", "into",
  "what", "which", "when", "where", "show", "list", "give", "find", "please",
  "about", "table", "tables", "data", "query", "select", "count", "all", "how",
  "cho", "toi", "cua", "cac", "nhung", "hay", "duoc", "bang", "voi", "trong",
]);

/**
 * Weighted token extraction. Returns a map of token → weight so a prompt token
 * that is a qualified identifier can outrank a generic word appearing in a
 * memory description. Weights mirror `extractMemoryKeywords`: qualified id (3),
 * snake_case (2), plain word (1).
 */
export function extractRecallTokens(text: string): Map<string, number> {
  const weights = new Map<string, number>();
  const bump = (token: string, weight: number) => {
    const clean = token.trim().toLowerCase();
    if (clean.length < 3 || clean.length > 64 || RECALL_STOP_WORDS.has(clean)) return;
    weights.set(clean, Math.max(weights.get(clean) ?? 0, weight));
  };
  for (const match of text.matchAll(/\b[a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z][a-zA-Z0-9_]*\b/g)) {
    bump(match[0], 3);
  }
  for (const match of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
    bump(match[0], 2);
  }
  for (const match of text.matchAll(/\b[a-zA-Z][a-zA-Z0-9]{2,}\b/g)) {
    bump(match[0], 1);
  }
  return weights;
}

/**
 * Scores one memory entry against the prompt's weighted tokens. The entry's
 * NAME is the strongest field (that is the handle the model cites), then its
 * description. Overlap contributes prompt-weight * field-weight; a prompt
 * identifier landing in a memory name is the highest-value match.
 */
export function scoreMemoryRelevance(
  entry: AgentMemoryRecallEntry,
  promptTokens: Map<string, number>,
): number {
  if (promptTokens.size === 0) return 0;
  const nameTokens = extractRecallTokens(entry.name);
  const descriptionTokens = extractRecallTokens(entry.description);
  let score = 0;
  for (const [token, promptWeight] of promptTokens) {
    if (nameTokens.has(token)) {
      score += promptWeight * 3;
    } else if (descriptionTokens.has(token)) {
      score += promptWeight * 2;
    }
  }
  return score;
}

/**
 * Ranks the memory index by relevance to the user prompt (descending), with a
 * deterministic tie-break: freshest first (updatedAt, ISO-lexicographic), then
 * name. Entries clearing the threshold are flagged `relevant` so the caller can
 * tell the agent which ones to load first. Pure: no clock, no I/O.
 */
export function rankAgentMemoriesByRelevance(
  entries: AgentMemoryRecallEntry[],
  userPrompt: string,
): RankedAgentMemory[] {
  const promptTokens = extractRecallTokens(userPrompt ?? "");
  return entries
    .map((entry) => {
      const score = scoreMemoryRelevance(entry, promptTokens);
      return {
        entry,
        score,
        relevant: score >= MEMORY_RECALL_RELEVANCE_THRESHOLD,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const freshness = (right.entry.updatedAt ?? "").localeCompare(left.entry.updatedAt ?? "");
      if (freshness !== 0) return freshness;
      return (left.entry.name ?? "").localeCompare(right.entry.name ?? "");
    });
}
