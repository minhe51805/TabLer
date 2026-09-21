import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import { isSupersededAIRequestError } from "../ai-agent-action-requestor";
import {
  AI_AGENT_DELEGATE_ANSWER_CHARS,
  AI_AGENT_DELEGATE_FOCUS_TABLES_LIMIT,
  AI_AGENT_DELEGATE_MAX_CALLS,
} from "../ai-agent-tools";
import { agentToolError } from "../agent-tool-executor-helpers";
import type { AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "delegate",
  handler: async (ctx, args) => {
    const instruction = typeof args?.instruction === "string" ? args.instruction.trim() : "";
    if (!instruction) {
      return agentToolError(
        "delegate requires args.instruction — a self-contained side question.",
        {
          hint: "Send args.instruction as a complete question, optionally with args.focusTables.",
        },
      );
    }
    if (!ctx.delegateSubAnalysis) {
      return "Tool notice: delegate is unavailable in this run — answer from the evidence you already have.";
    }
    if (ctx.delegateCallsUsed >= AI_AGENT_DELEGATE_MAX_CALLS) {
      return `Tool notice: delegate budget exhausted (${AI_AGENT_DELEGATE_MAX_CALLS}/${AI_AGENT_DELEGATE_MAX_CALLS} used) — continue with your own tools or finish.`;
    }
    const focusTables = Array.isArray(args?.focusTables)
      ? (args.focusTables as unknown[])
          .filter((table): table is string => typeof table === "string" && Boolean(table.trim()))
          .map((table) => table.trim())
          .slice(0, AI_AGENT_DELEGATE_FOCUS_TABLES_LIMIT)
      : [];
    ctx.delegateCallsUsed += 1;
    try {
      const answer = await ctx.delegateSubAnalysis(instruction, focusTables);
      const clean = answer.trim();
      if (!clean) {
        return "Side analysis returned nothing. Continue with your own tools.";
      }
      const bounded =
        clean.length > AI_AGENT_DELEGATE_ANSWER_CHARS
          ? `${clean.slice(0, AI_AGENT_DELEGATE_ANSWER_CHARS)}… [truncated]`
          : clean;
      return `Side analysis${focusTables.length > 0 ? ` (focus: ${focusTables.join(", ")})` : ""}:\n${bounded}`;
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      return `Side analysis failed: ${formatExecutionError(errorValue)}. Continue with your own tools.`;
    }
  },
};
