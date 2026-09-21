import { AI_AGENT_PLAN_STEP_LIMIT } from "../ai-agent-tools";
import { agentToolError, normalizeAgentPlanSteps } from "../agent-tool-executor-helpers";
import { stringifyAgentObservation, type AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "update_plan",
  handler: async (ctx, args, frame) => {
    const plan = normalizeAgentPlanSteps(args?.steps, AI_AGENT_PLAN_STEP_LIMIT);
    if (plan.length === 0) {
      return agentToolError(
        "update_plan requires args.steps — a non-empty array of { title, status? } entries.",
        {
          hint: 'Send args.steps like [{"title":"Locate the orders table","status":"in_progress"}].',
        },
      );
    }
    ctx.onAgentPlanUpdate?.(plan);
    const done = plan.filter((step) => step.status === "done").length;
    const inProgress = plan.filter((step) => step.status === "in_progress").length;
    return stringifyAgentObservation(frame, {
      planUpdated: true,
      steps: plan.length,
      done,
      inProgress,
      pending: plan.length - done - inProgress,
      checklist: plan.map((step, index) => `${index + 1}. [${step.status}] ${step.title}`),
    });
  },
};
