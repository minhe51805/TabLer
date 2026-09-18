import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildInsightScope, useAgentInsightsStore } from "@/stores/agent-insights-store";
import {
  INSIGHT_COOLDOWN_MILLIS,
  type AgentInsight,
} from "@/components/AISlidePanel/ai-agent-insights";

const SCOPE_SHOP = buildInsightScope("conn-a", "shop");
const SCOPE_CRM = buildInsightScope("conn-a", "crm");
const FINDING_ID = "high-null-column:users:email";

function insight(): AgentInsight {
  return {
    id: FINDING_ID,
    kind: "high-null-column",
    table: "users",
    column: "email",
    title: "users.email is never populated",
    detail: "99.8% of the 500 rows seen are NULL.",
    evidence: {
      executedSql: "SELECT COUNT(*) AS __total FROM users",
      rowCount: 500,
      digest: "abcdef01",
    },
    confidence: 95,
    suggestedAction: { label: "Check the column", prefill: "SELECT 1;", danger: false },
  };
}

describe("agent-insights-store", () => {
  beforeEach(() => {
    useAgentInsightsStore.setState({ insights: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a run's findings under the database they were proved on", () => {
    useAgentInsightsStore.getState().recordRunInsights([insight()], SCOPE_SHOP);
    const [stored] = useAgentInsightsStore.getState().insights;
    expect(stored.scope).toBe(SCOPE_SHOP);
    expect(stored.evidence.rowCount).toBe(500);
    expect(stored.seenAt).toBeTypeOf("number");
  });

  it("does not re-announce a finding inside the cooldown window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const record = () =>
      useAgentInsightsStore.getState().recordRunInsights([insight()], SCOPE_SHOP);
    record();
    const firstSeenAt = useAgentInsightsStore.getState().insights[0].seenAt;

    vi.advanceTimersByTime(60 * 60 * 1000);
    record();
    expect(useAgentInsightsStore.getState().insights).toHaveLength(1);
    // Dropped rather than refreshed: the card still carries the timestamp it
    // was first shown at, so the user is not told the same thing twice.
    expect(useAgentInsightsStore.getState().insights[0].seenAt).toBe(firstSeenAt);

    vi.advanceTimersByTime(INSIGHT_COOLDOWN_MILLIS);
    record();
    const lapsedSeenAt = useAgentInsightsStore.getState().insights[0].seenAt;
    expect(useAgentInsightsStore.getState().insights).toHaveLength(1);
    expect(lapsedSeenAt).toBe((firstSeenAt ?? 0) + 60 * 60 * 1000 + INSIGHT_COOLDOWN_MILLIS);
  });

  it("keeps the same finding id from two databases apart", () => {
    useAgentInsightsStore.getState().recordRunInsights([insight()], SCOPE_SHOP);
    useAgentInsightsStore.getState().recordRunInsights([insight()], SCOPE_CRM);
    const scopes = useAgentInsightsStore
      .getState()
      .insights.map((entry) => entry.scope)
      .sort();
    expect(scopes).toEqual([SCOPE_CRM, SCOPE_SHOP].sort());
  });

  it("leaves stored cards alone when a run proves nothing", () => {
    useAgentInsightsStore.getState().recordRunInsights([insight()], SCOPE_SHOP);
    useAgentInsightsStore.getState().recordRunInsights([], SCOPE_SHOP);
    expect(useAgentInsightsStore.getState().insights).toHaveLength(1);
  });

  it("dismisses a single card and clears the rest", () => {
    const other = { ...insight(), id: "constant-column:users:legacy_flag" };
    useAgentInsightsStore.getState().recordRunInsights([insight(), other], SCOPE_SHOP);
    expect(useAgentInsightsStore.getState().insights).toHaveLength(2);

    useAgentInsightsStore.getState().dismissInsight(other.id);
    expect(useAgentInsightsStore.getState().insights.map((entry) => entry.id)).toEqual([
      FINDING_ID,
    ]);

    useAgentInsightsStore.getState().clearInsights();
    expect(useAgentInsightsStore.getState().insights).toEqual([]);
  });
});
