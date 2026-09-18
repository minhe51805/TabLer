/**
 * Proactive insight cards (P8).
 *
 * Renders what the run-end collector proved about the data a finished run just
 * read. The cards are read-only findings: taking a suggestion hands the
 * statement to the SQL editor (`insert-sql-from-ai`) and never runs it, so a
 * suggestion can never execute without the user pressing Run themselves. That
 * is deliberate — a proactive finding must not be a way to skip the write gate.
 */

import { useMemo } from "react";
import "../../styles/ai-insights.css";
import { useAgentInsightsStore } from "../../stores/agent-insights-store";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";

interface AIAgentInsightsProps {
  copy: AIWorkspaceCopy;
  /** Database scope the cards must belong to (`buildInsightScope` key). */
  scope: string;
}

export function AIAgentInsights({ copy, scope }: AIAgentInsightsProps) {
  const insights = useAgentInsightsStore((state) => state.insights);
  const dismissInsight = useAgentInsightsStore((state) => state.dismissInsight);
  const clearInsights = useAgentInsightsStore((state) => state.clearInsights);
  const visible = useMemo(
    () => insights.filter((insight) => insight.scope === scope),
    [insights, scope],
  );
  if (visible.length === 0) return null;
  return (
    <section className="ai-insights-strip" data-testid="ai-insights-strip">
      <div className="ai-insights-header">
        <span className="ai-insights-title">{copy.insights.title}</span>
        <button
          type="button"
          className="ai-insights-clear"
          title={copy.insights.clearAll}
          onClick={clearInsights}
        >
          {copy.insights.clearAll}
        </button>
      </div>
      <ul className="ai-insights-list">
        {visible.map((insight) => (
          <li
            key={`${insight.scope}::${insight.id}`}
            className="ai-insights-card"
            data-insight-kind={insight.kind}
          >
            <span className="ai-insights-card-title">{insight.title}</span>
            <p className="ai-insights-card-detail">{insight.detail}</p>
            <div className="ai-insights-card-meta">
              <span className="ai-insights-confidence">
                {insight.confidence}% {copy.insights.confidence}
              </span>
              <span>{copy.insights.evidence}</span>
            </div>
            <code className="ai-insights-evidence" title={insight.evidence.executedSql}>
              {insight.evidence.executedSql}
            </code>
            {insight.suggestedAction.danger ? (
              <span className="ai-insights-review-warning">{copy.insights.reviewFirst}</span>
            ) : null}
            <div className="ai-insights-card-actions">
              <button
                type="button"
                className="ai-insights-action"
                title={copy.insights.useSuggestion}
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent("insert-sql-from-ai", {
                      detail: { sql: insight.suggestedAction.prefill },
                    }),
                  );
                  dismissInsight(insight.id);
                }}
              >
                {insight.suggestedAction.label}
              </button>
              <button
                type="button"
                className="ai-insights-action"
                onClick={() => dismissInsight(insight.id)}
              >
                {copy.insights.dismiss}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
