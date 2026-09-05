import { BookOpen, PenLine, Brain, CheckCircle2, ChevronDown, ChevronRight, Database, Eye, HelpCircle, ListTree, Loader2, Search, Sparkles, AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { getAIWorkspaceCopy } from "./ai-workspace-copy";
import { AIWorkspaceMarkdown } from "./AIWorkspaceMarkdown";
import { parseAgentFacts } from "./ai-agent-context";
import type { AIWorkspaceAgentActionName, AIWorkspaceAgentStep } from "./ai-workspace-types";

interface AIAgentStepsProps {
  steps: AIWorkspaceAgentStep[];
  /** Compact view (inside a bubble) shows a short observation peek instead of the full body. */
  compact?: boolean;
  /** Total run time (bubble settle − creation); shown on the collapsed header. */
  durationMs?: number;
}

/** One-liner for the collapsed header: what the agent was actually doing. */
/** Live-run status verbs shown in the collapsed header and think rows. Older
 *  persisted runs still carry the long "Deciding next action (step N)." strings
 *  inside their saved agentSteps — normalize them to the current terse verbs so
 *  re-opened conversations read the same as fresh runs. */
function normalizeThinkMessage(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  if (/^Deciding next action \(step \d+\)\.?$/u.test(flat)) return "Thinking…";
  if (/^Tool budget reached\b/u.test(flat)) return "Wrapping up…";
  if (flat === "Composing response.") return "Composing response…";
  return flat;
}

function headerThinkingTitle(steps: AIWorkspaceAgentStep[]): string {
  const flat = normalizeThinkMessage(
    steps.find((step) => step.action === "think"
      && step.message
      && step.message !== "No message provided.")?.message ?? "",
  );
  if (!flat) return "";
  return flat.length > 90 ? `${flat.slice(0, 87)}...` : flat;
}

/** "42s" / "1m 12s" for the collapsed header, opencode/Codex style. */
function formatStepsDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function getActionIcon(action: AIWorkspaceAgentActionName): ReactNode {
  switch (action) {
    case "plan":
    case "think":
      return <Brain className="w-3.5 h-3.5" />;
    case "update_plan":
      return <ListTree className="w-3.5 h-3.5" />;
    case "delegate":
      return <Brain className="w-3.5 h-3.5" />;
    case "ask_user":
      return <HelpCircle className="w-3.5 h-3.5" />;
    case "list_tables":
      return <ListTree className="w-3.5 h-3.5" />;
    case "search_schema":
    case "list_schema_objects":
    case "describe_table":
    case "describe_tables":
      return <Search className="w-3.5 h-3.5" />;
    case "sample_table_data":
    case "run_readonly_sql":
    case "run_preset":
      return <Database className="w-3.5 h-3.5" />;
    case "remember_term":
      return <BookOpen className="w-3.5 h-3.5" />;
    case "read_page":
      return <Eye className="w-3.5 h-3.5" />;
    case "preview_write":
      return <PenLine className="w-3.5 h-3.5" />;
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
    case "think":
      return copy.modal.agentActionThink;
    case "update_plan":
      return copy.modal.agentActionPlan;
    case "delegate":
      return copy.modal.agentActionThink;
    case "ask_user":
      return copy.modal.agentActionAskUser;
    case "list_tables":
      return copy.modal.agentActionListTables;
    case "search_schema":
    case "list_schema_objects":
    case "describe_table":
    case "describe_tables":
      return copy.modal.agentActionDescribeTable;
    case "sample_table_data":
    case "run_readonly_sql":
    case "run_preset":
      return copy.modal.agentActionRunSql;
    case "remember_term":
      return copy.modal.agentActionRememberTerm;
    case "create_checkpoint":
      return copy.modal.agentActionCreateCheckpoint;
    case "restore_checkpoint":
      return copy.modal.agentActionRestoreCheckpoint;
    case "read_page":
      return copy.modal.agentActionThink;
    case "preview_write":
      return copy.modal.agentActionPreviewWrite;
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

export function AIAgentSteps({ steps, compact = false, durationMs }: AIAgentStepsProps) {
  const { language } = useI18n();
  const copy = getAIWorkspaceCopy(language);
  const runSettled = steps.length > 0 && steps.every((step) => step.status !== "running");
  const [expanded, setExpanded] = useState(!runSettled);

  // Collapse automatically once the run finishes so the final report is the
  // visible content; live runs stay open until the last step settles.
  useEffect(() => {
    setExpanded(!runSettled);
  }, [runSettled]);

  if (steps.length === 0) return null;

  const thinkingTitle = !expanded ? headerThinkingTitle(steps) : "";
  const showDuration = Boolean(!expanded && runSettled && durationMs && durationMs > 0);

  return (
    <div className={`ai-agent-steps ${compact ? "is-compact" : ""} ${expanded ? "" : "is-collapsed"}`}>
      <button
        type="button"
        className="ai-agent-steps-head"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        title={expanded ? copy.modal.agentStatusDone : thinkingTitle || undefined}
      >
        <Sparkles className="w-3.5 h-3.5" />
        <span>{copy.modal.agentStepsLabel}</span>
        {showDuration && <span className="ai-agent-steps-duration">{formatStepsDuration(durationMs as number)}</span>}
        {thinkingTitle && <span className="ai-agent-steps-title">{thinkingTitle}</span>}
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 ai-agent-steps-chevron" />
          : <ChevronRight className="w-3.5 h-3.5 ai-agent-steps-chevron" />}
      </button>
      {expanded && (
      <ol className="ai-agent-steps-list">
        {steps.map((step) => {
          const statusLabel =
            step.status === "running"
              ? copy.modal.agentStatusRunning
              : step.status === "error"
                ? copy.modal.agentStatusError
                : copy.modal.agentStatusDone;
          const isPlan = step.action === "plan";
          // A running "think" step ("Thinking…" / "Composing response…")
          // renders as a dots-only live pill like the plan row — the message
          // stays available for the collapsed header and the settled trace.
          const isThinkWait = step.action === "think" && step.status === "running";
          // The machine-readable `@@facts:` footer is harness plumbing — it
          // feeds the quality gates but must never render into the visible
          // trace (audit fix: it used to leak raw JSON into the bubble).
          const observation = parseAgentFacts(step.observation ?? "").text.trim();
          // Models sometimes omit the per-step message; fall back to a
          // localized action label instead of showing "No message provided.".
          const displayMessage = step.message.trim() && step.message !== "No message provided."
            ? step.action === "think"
              ? normalizeThinkMessage(step.message)
              : step.message
            : getActionLabel(step.action, copy);
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
                  {!isPlan && !isThinkWait && (
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

                {isPlan && step.status === "running" && (
                  <div className="ai-agent-step-live-activity" aria-live="polite">
                    <span className="ai-agent-step-live-dots" aria-hidden="true"><span /><span /><span /></span>
                    <span>{copy.modal.agentStatusRunning}</span>
                  </div>
                )}
                {isThinkWait && (
                  <div className="ai-agent-step-live-activity" aria-live="polite">
                    <span className="ai-agent-step-live-dots" aria-hidden="true"><span /><span /><span /></span>
                    <span className="sr-only">{statusLabel}</span>
                  </div>
                )}

                {displayMessage && !isThinkWait && (
                  isPlan ? (
                    <AIWorkspaceMarkdown className="ai-agent-step-plan-text" compact text={displayMessage} />
                  ) : (
                    <p className="ai-agent-step-message">{displayMessage}</p>
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
      )}
    </div>
  );
}
