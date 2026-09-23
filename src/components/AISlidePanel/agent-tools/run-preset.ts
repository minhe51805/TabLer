import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "../ai-agent-action-requestor";
import { agentSqlToolBlockedMessage } from "../ai-agent-engine-gates";
import { summarizeAgentQueryObservation } from "../ai-agent-grounding";
import {
  agentToolError,
  agentSqlErrorHint,
  isRetryableAgentToolError,
} from "../agent-tool-executor-helpers";
import { getAdminQueryPreset, type AdminQueryKind } from "../../../utils/admin-query-presets";
import { stringifyAgentObservation, type AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "run_preset",
  handler: async (ctx, args, frame) => {
    if (ctx.toolAvailability && !ctx.toolAvailability.presets) {
      return agentSqlToolBlockedMessage("run_preset", ctx.toolAvailability);
    }
    const wantsList = args?.list === true || typeof args?.presetId !== "string";
    const presetKinds: AdminQueryKind[] = ["process-list", "user-management"];
    if (wantsList) {
      return stringifyAgentObservation(frame, {
        engine: ctx.toolAvailability?.engineLabel ?? "current engine",
        availablePresets: presetKinds.map((kind) => ({
          presetId: kind,
          ...(() => {
            const preset = getAdminQueryPreset(ctx.dbType, kind);
            return { supported: preset.supported, reason: preset.reason };
          })(),
        })),
        note: "Call again with args.presetId to run a preset. Preset SQL is pre-vetted per engine - catalog guards do not apply to it.",
      });
    }
    const presetId = args?.presetId === "user-management" ? "user-management" : "process-list";
    const preset = getAdminQueryPreset(ctx.dbType, presetId as AdminQueryKind);
    if (!preset.supported) {
      return `Tool blocked: the "${presetId}" preset is not available on this engine${preset.reason ? `: ${preset.reason}` : "."}`;
    }
    if (ctx.requestDataReadConsent) {
      const approved = await ctx.requestDataReadConsent();
      if (!approved) {
        return "Tool blocked: The user did not grant permission to read live database rows for this request.";
      }
    }
    // A superseded run must not hit the database at all — check before the
    // backend call, not only after it.
    if (ctx.requestId !== ctx.requestIdRef.current) {
      throw new Error(AI_REQUEST_REPLACED_MESSAGE);
    }

    try {
      frame.sql = preset.content;
      const queryResult = await ctx.executeReadonlyQuery(ctx.connectionId!, [preset.content]);
      if (ctx.requestId !== ctx.requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }
      return stringifyAgentObservation(frame, {
        presetId,
        note: "Executed a pre-vetted operational preset (not model-written SQL).",
        result: summarizeAgentQueryObservation(queryResult),
      });
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      return agentToolError(`preset "${presetId}" failed: ${formatExecutionError(errorValue)}`, {
        hint: agentSqlErrorHint(errorValue),
        retryable: isRetryableAgentToolError(errorValue),
      });
    }
  },
};
