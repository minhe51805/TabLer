import { beforeEach, describe, expect, it } from "vitest";

import { useAgentLearningStore } from "@/stores/agent-learning-store";
import type { LearningProposal } from "@/components/AISlidePanel/ai-agent-learning";

const SCOPE_A = "conn-a::shop";
const SCOPE_B = "conn-a::crm";
const TARGET = { connectionId: "conn-a", database: "shop" };

function memoryProposal(id = "memory:high-null-column:users:email"): LearningProposal {
  return {
    id,
    kind: "memory",
    title: "Remember this",
    rationale: "The run proved it.",
    memory: { name: "users-email", description: "d", body: "b" },
  };
}

function ruleProposal(id = "rule:soft-delete-candidate:users:deleted_at"): LearningProposal {
  return {
    id,
    kind: "rule",
    title: "Warn on this",
    rationale: "The user filtered on a dead column.",
    rule: {
      name: "flagged-column-users-deleted-at",
      description: "d",
      event: "pre_read",
      action: "warn",
      pattern: "(?i)\\bdeleted_at\\b",
    },
  };
}

describe("agent-learning-store", () => {
  beforeEach(() => {
    useAgentLearningStore.setState({ proposals: [] });
  });

  it("keeps the scope and the write target with each offer", () => {
    useAgentLearningStore.getState().recordRunLearnings([memoryProposal()], SCOPE_A, TARGET);
    const [entry] = useAgentLearningStore.getState().proposals;
    expect(entry.scope).toBe(SCOPE_A);
    expect(entry.target).toEqual(TARGET);
    expect(entry.proposal.kind).toBe("memory");
  });

  it("lets a new run replace this screen's offers but not another database's", () => {
    useAgentLearningStore.getState().recordRunLearnings([memoryProposal()], SCOPE_A, TARGET);
    useAgentLearningStore.getState().recordRunLearnings([memoryProposal()], SCOPE_B, TARGET);
    useAgentLearningStore.getState().recordRunLearnings([ruleProposal()], SCOPE_A, TARGET);

    const proposals = useAgentLearningStore.getState().proposals;
    expect(proposals.map((entry) => entry.proposal.id).sort()).toEqual(
      [memoryProposal().id, ruleProposal().id].sort(),
    );
    expect(proposals.filter((entry) => entry.scope === SCOPE_B)).toHaveLength(1);
  });

  it("leaves the offers alone when a run proposed nothing", () => {
    useAgentLearningStore.getState().recordRunLearnings([memoryProposal()], SCOPE_A, TARGET);
    useAgentLearningStore.getState().recordRunLearnings([], SCOPE_A, TARGET);
    expect(useAgentLearningStore.getState().proposals).toHaveLength(1);
  });

  it("drops a dismissed offer and clears the rest", () => {
    useAgentLearningStore
      .getState()
      .recordRunLearnings([memoryProposal(), ruleProposal()], SCOPE_A, TARGET);
    useAgentLearningStore.getState().dismissLearning(ruleProposal().id);
    expect(useAgentLearningStore.getState().proposals.map((entry) => entry.proposal.id)).toEqual([
      memoryProposal().id,
    ]);

    useAgentLearningStore.getState().clearLearnings();
    expect(useAgentLearningStore.getState().proposals).toEqual([]);
  });
});
