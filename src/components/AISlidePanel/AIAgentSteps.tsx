import { Brain, CheckCircle2, Database, ListTree, Loader2, Search, Sparkles, AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../../i18n";
import { getAIWorkspaceCopy } from "./ai-workspace-copy";
import { AIWorkspaceMarkdown } from "./AIWorkspaceMarkdown";
import type { AIWorkspaceAgentActionName, AIWorkspaceAgentStep } from "./ai-workspace-types";

interface AIAgentStepsProps {
  steps: AIWorkspaceAgentStep[];
  /** Compact view (inside a bubble) shows a short observation peek instead of the full body. */
  compact?: boolean;
}

function getActionIcon(action: AIWorkspaceAgentActionName): ReactNode {
  switch (action) {
    case "plan":
      return <Brain className="w-3.5 h-3.5" />;
    case "list_tables":
      return <ListTree className="w-3.5 h-3.5" />;
    case "describe_table":
      return <Search className="w-3.5 h-3.5" />;
    case "run_readonly_sql":
      return <Database className="w-3.5 h-3.5" />;
    case "finish":
    default:
      return <Sparkles className="w-3.5 h-3.5" />;
  }
}

function getActionLabel(
  action: AIWorkspaceAgentActionName,
  copy: ReturnType<typeof getAIWorkspaceCopy>
): string {
  switch (action) {
    case "plan":
      return copy.modal.agentActionPlan;
    case "list_tables":
      return copy.modal.agentActionListTables;
    case "describe_table":
      return copy.modal.agentActionDescribeTable;
    case "run_readonly_sql":
      return copy.modal.agentActionRunSql;
    case "finish":
    default:
      return copy.modal.agentActionFinish;
  }
}

/** Trim a tool observation down to a readable one-liner for the compact peek. */
function peekObservation(observation: string): string {
  const flat = observation.replace(/\s+/g, " ").trim();
  if (flat.length <= 140) return flat;
  return `${flat.slice(0, 137)}...`;
}

export function AIAgentSteps({ steps, compact = false }: AIAgentStepsProps) {
  const { language } = useI18n();
  const copy = getAIWorkspaceCopy(language);
  if (steps.length === 0) return null;

  return (
    <div className={`ai-agent-steps ${compact ? "is-compact" : ""}`}>
      <div className="ai-agent-steps-head">
        <Sparkles className="w-3.5 h-3.5" />
        <span>{copy.modal.agentStepsLabel}</span>
      </div>
      <ol className="ai-agent-steps-list">
        {steps.map((step) => {
          const statusLabel =
            step.status === "running"
              ? copy.modal.agentStatusRunning
              : step.status === "error"
                ? copy.modal.agentStatusError
                : copy.modal.agentStatusDone;
          const isPlan = step.action === "plan";
          const observation = step.observation?.trim();
          return (
            <li
              key={step.step}
              className={`ai-agent-step ai-agent-step--${step.status} ${isPlan ? "ai-agent-step--plan" : ""}`}
            >
              <span className="ai-agent-step-rail" aria-hidden="true">
                <span className="ai-agent-step-icon">{getActionIcon(step.action)}</span>
              </span>
              <div className="ai-agent-step-body">
                <div className="ai-agent-step-line">
                  <span className="ai-agent-step-action">{getActionLabel(step.action, copy)}</span>
                  {!isPlan && (
                    <span className={`ai-agent-step-status ai-agent-step-status--${step.status}`}>
                      {step.status === "running" ? (
                        <Loader2 className="w-3 h-3 ai-agent-step-spin" />
                      ) : step.status === "error" ? (
                        <AlertCircle className="w-3 h-3" />
                      ) : (
                        <CheckCircle2 className="w-3 h-3" />
                      )}
                      {statusLabel}
                    </span>
                  )}
                </div>

                {step.message && (
                  isPlan ? (
                    <AIWorkspaceMarkdown className="ai-agent-step-plan-text" compact text={step.message} />
                  ) : (
                    <p className="ai-agent-step-message">{step.message}</p>
                  )
                )}

                {!isPlan && observation && (
                  compact ? (
                    <p className="ai-agent-step-peek">{peekObservation(observation)}</p>
                  ) : (
                    <pre className="ai-agent-step-observation">{observation}</pre>
                  )
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
