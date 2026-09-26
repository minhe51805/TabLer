import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import { isSupersededAIRequestError } from "../ai-agent-action-requestor";
import { agentToolError, isRetryableAgentToolError } from "../agent-tool-executor-helpers";
import { emitAppToast } from "../../../utils/app-toast";
import { getAISemanticCopy } from "../ai-semantic-copy";
import { saveSemanticGlossaryEntry } from "../../../utils/semantic-glossary";
import { stringifyAgentObservation, type AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "remember_term",
  handler: async (ctx, args, frame) => {
    const term = typeof args?.term === "string" ? args.term.trim() : "";
    const definition = typeof args?.definition === "string" ? args.definition.trim() : "";
    if (!term || !definition) {
      return agentToolError("remember_term requires args.term and args.definition.", {
        hint: 'Send args.term and args.definition (optionally args.kind: "term"|"metric"|"relationship"|"alias").',
      });
    }
    try {
      const savedEntry = await saveSemanticGlossaryEntry({
        connectionId: ctx.connectionId!,
        database: ctx.currentDatabase || undefined,
        term,
        definition,
        kind: args?.kind as "term" | "metric" | "relationship" | "alias" | undefined,
        source: "agent",
      });
      // remember_term used to write silently — a toast + activity event keeps
      // "the agent learned something" observable like save_memory already is.
      // The entry may be void on mocked backends, so fall back to the term.
      const savedTerm = savedEntry?.term ?? term;
      const semanticCopy = getAISemanticCopy(ctx.language ?? "en");
      emitAppToast({
        tone: "info",
        title: semanticCopy.savedToastTitle,
        description: semanticCopy.savedToastBody.replace("{term}", savedTerm),
        durationMs: 4000,
      });
      window.dispatchEvent(
        new CustomEvent("workspace-activity", {
          detail: {
            connectionId: ctx.connectionId,
            label: `Glossary saved: ${savedTerm}`,
            durationMs: 0,
          },
        }),
      );
      return stringifyAgentObservation(frame, {
        saved: term,
        definition,
        note: "Saved to the business glossary; future runs for this database will see it automatically.",
      });
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      return agentToolError(
        `could not save the glossary entry: ${formatExecutionError(errorValue)}`,
        {
          retryable: isRetryableAgentToolError(errorValue),
        },
      );
    }
  },
};
