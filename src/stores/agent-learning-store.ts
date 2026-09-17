/**
 * Learning proposals (P9).
 *
 * In RAM on purpose, and the opposite of the insight store: an insight is a
 * durable finding the user should still see tomorrow, while a proposal is a
 * one-shot offer to write something. Persisting it would resurrect approvals
 * whose evidence has gone stale — and the only honest way to write is the click
 * the user just made, not one from last week.
 *
 * Scoped like insights: a proposal learned on one database is not an offer to
 * write against another.
 */

import { create } from "zustand";
import type { LearningProposal, LearningScope } from "../components/AISlidePanel/ai-agent-learning";

export interface ScopedLearningProposal {
  proposal: LearningProposal;
  /** Display/filter key (`buildInsightScope`). */
  scope: string;
  /** Where an approved proposal is written. */
  target: LearningScope;
}

interface AgentLearningState {
  proposals: ScopedLearningProposal[];
  /** Replaces the offers on screen with the ones a finished run just raised. */
  recordRunLearnings: (
    proposals: readonly LearningProposal[],
    scope: string,
    target: LearningScope,
  ) => void;
  dismissLearning: (id: string) => void;
  clearLearnings: () => void;
}

export const useAgentLearningStore = create<AgentLearningState>()((set) => ({
  proposals: [],
  recordRunLearnings: (proposals, scope, target) =>
    set((state) => {
      if (proposals.length === 0) return state;
      // A new run's offers supersede the previous run's: they describe the same
      // screen, and stacking two runs of proposals buries both.
      const carried = state.proposals.filter((entry) => entry.scope !== scope);
      return {
        proposals: [...carried, ...proposals.map((proposal) => ({ proposal, scope, target }))],
      };
    }),
  dismissLearning: (id) =>
    set((state) => ({
      proposals: state.proposals.filter((entry) => entry.proposal.id !== id),
    })),
  clearLearnings: () => set({ proposals: [] }),
}));
