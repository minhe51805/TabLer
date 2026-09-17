import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AIAgentInsights } from "@/components/AISlidePanel/AIAgentInsights";
import { getAIWorkspaceCopy } from "@/components/AISlidePanel/ai-workspace-copy";
import type { AgentInsight } from "@/components/AISlidePanel/ai-agent-insights";
import { buildInsightScope, useAgentInsightsStore } from "@/stores/agent-insights-store";

const copy = getAIWorkspaceCopy("en");
const SCOPE = buildInsightScope("conn-a", "shop");
const OTHER_SCOPE = buildInsightScope("conn-b", "shop");
const EVIDENCE_SQL =
  "SELECT COUNT(*) AS __total, SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS __null_0 FROM users";
const PREFILL = "SELECT COUNT(*), SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) FROM users;";

const finding: AgentInsight = {
  id: "soft-delete-candidate:users:deleted_at",
  kind: "soft-delete-candidate",
  table: "users",
  column: "deleted_at",
  title: "users.deleted_at is never populated",
  detail: "100% of the 500 rows seen are NULL.",
  evidence: { executedSql: EVIDENCE_SQL, rowCount: 500, digest: "deadbeef" },
  confidence: 95,
  suggestedAction: { label: "Check the flag", prefill: PREFILL, danger: false },
};

function record(scope = SCOPE) {
  useAgentInsightsStore.getState().recordRunInsights([finding], scope);
}

describe("AIAgentInsights", () => {
  beforeEach(() => {
    useAgentInsightsStore.setState({ insights: [] });
  });

  it("renders nothing until a run has proved something", () => {
    render(<AIAgentInsights copy={copy} scope={SCOPE} />);
    expect(screen.queryByTestId("ai-insights-strip")).toBeNull();
  });

  it("shows the finding with its computed confidence and the statement behind it", () => {
    record();
    render(<AIAgentInsights copy={copy} scope={SCOPE} />);
    expect(screen.getByTestId("ai-insights-strip")).toBeInTheDocument();
    expect(screen.getByText("users.deleted_at is never populated")).toBeInTheDocument();
    expect(screen.getByText("95% confidence")).toBeInTheDocument();
    expect(screen.getByTitle(EVIDENCE_SQL)).toBeInTheDocument();
  });

  it("hides findings proved on another database", () => {
    record(OTHER_SCOPE);
    render(<AIAgentInsights copy={copy} scope={SCOPE} />);
    expect(screen.queryByTestId("ai-insights-strip")).toBeNull();
  });

  it("hands a suggestion to the editor instead of running it", async () => {
    const listener = vi.fn();
    window.addEventListener("insert-sql-from-ai", listener as EventListener);
    record();
    render(<AIAgentInsights copy={copy} scope={SCOPE} />);

    await userEvent.click(screen.getByRole("button", { name: "Check the flag" }));

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent<{ sql: string }>;
    expect(event.detail).toEqual({ sql: PREFILL });
    // Taking a suggestion retires the card: the user has acted on it.
    expect(screen.queryByTestId("ai-insights-strip")).toBeNull();
    window.removeEventListener("insert-sql-from-ai", listener as EventListener);
  });

  it("dismisses a card the user does not care about", async () => {
    record();
    render(<AIAgentInsights copy={copy} scope={SCOPE} />);
    await userEvent.click(screen.getByRole("button", { name: copy.insights.dismiss }));
    expect(screen.queryByTestId("ai-insights-strip")).toBeNull();
  });

  it("warns before a suggestion that can change data", () => {
    useAgentInsightsStore
      .getState()
      .recordRunInsights(
        [{ ...finding, suggestedAction: { ...finding.suggestedAction, danger: true } }],
        SCOPE,
      );
    render(<AIAgentInsights copy={copy} scope={SCOPE} />);
    expect(screen.getByText(copy.insights.reviewFirst)).toBeInTheDocument();
  });
});
