import { CheckCircle2, Database, ListTree, Loader2, Search, Sparkles, AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../../i18n";
import { getAIWorkspaceCopy } from "./ai-workspace-copy";
import type { AIWorkspaceAgentActionName, AIWorkspaceAgentStep } from "./ai-workspace-types";

interface AIAgentStepsProps {
  steps: AIWorkspaceAgentStep[];
  /** Compact view (inside a bubble) hides observation bodies. */
  compact?: boolean;
}

function getActionIcon(action: AIWorkspaceAgentActionName): ReactNode {
  switch (action) {
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
          return (
            <li key={step.step} className={`ai-agent-step ai-agent-step--${step.status}`}>
              <span className="ai-agent-step-icon">{getActionIcon(step.action)}</span>
              <div className="ai-agent-step-body">
                <div className="ai-agent-step-line">
                  <span className="ai-agent-step-action">{getActionLabel(step.action, copy)}</span>
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
                </div>
                {step.message && <p className="ai-agent-step-message">{step.message}</p>}
                {!compact && step.observation && (
                  <pre className="ai-agent-step-observation">{step.observation}</pre>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
