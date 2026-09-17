/**
 * Proactive insight cards (P8).
 *
 * Holds what the run-end collector proved, with the dedupe / cooldown / cap
 * policy applied on the way in, so the panel can render the cards without
 * re-deriving anything. Persisted because the cooldown window is measured in
 * hours and days — an in-RAM store would forget every restart and let the same
 * finding resurface immediately.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { mergeInsightCards, type AgentInsight } from "../components/AISlidePanel/ai-agent-insights";

/**
 * A stored card: the engine's finding plus the database it was proved on.
 * Findings are per-database — "`users.deleted_at` is never populated" is a
 * claim about one schema, and showing it while the user is looking at another
 * connection would be a statement the evidence does not support.
 */
export interface ScopedAgentInsight extends AgentInsight {
  scope: string;
}

/** Scope key for a workspace target. Empty halves are preserved so that an
 * unset database never collides with a set one. */
export function buildInsightScope(connectionId?: string | null, database?: string | null): string {
  return `${connectionId ?? ""}::${database ?? ""}`;
}

interface AgentInsightsState {
  insights: ScopedAgentInsight[];
  /** Folds a finished run's findings into the cards already on screen. */
  recordRunInsights: (incoming: readonly AgentInsight[], scope: string) => void;
  dismissInsight: (id: string) => void;
  clearInsights: () => void;
}

const scopeKey = (insight: ScopedAgentInsight) => `${insight.scope}::${insight.id}`;

export const useAgentInsightsStore = create<AgentInsightsState>()(
  persist(
    (set) => ({
      insights: [],
      recordRunInsights: (incoming, scope) => {
        if (incoming.length === 0) return;
        set((state) => ({
          insights: mergeInsightCards(
            state.insights,
            incoming.map((insight) => ({ ...insight, scope })),
            { now: Date.now(), keyOf: scopeKey },
          ),
        }));
      },
      dismissInsight: (id) =>
        set((state) => ({
          insights: state.insights.filter((insight) => insight.id !== id),
        })),
      clearInsights: () => set({ insights: [] }),
    }),
    { name: "tabler.ai.insights.v1" },
  ),
);
