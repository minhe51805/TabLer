import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "../ai-agent-action-requestor";
import { agentSqlToolBlockedMessage } from "../ai-agent-engine-gates";
import { redactAgentSqlLiterals } from "../ai-agent-grounding";
import {
  AI_AGENT_SCHEMA_OBJECT_DEFINITION_CHARS,
  AI_AGENT_SCHEMA_OBJECTS_LIMIT,
} from "../ai-agent-tools";
import { agentToolError, isRetryableAgentToolError } from "../agent-tool-executor-helpers";
import { invokeMutation } from "../../../utils/tauri-utils";
import { stringifyAgentObservation, type AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "list_schema_objects",
  handler: async (ctx, args, frame) => {
    if (ctx.toolAvailability && !ctx.toolAvailability.schemaObjects) {
      return agentSqlToolBlockedMessage("list_schema_objects", ctx.toolAvailability);
    }

    const objectType =
      typeof args?.objectType === "string" && args.objectType !== "all"
        ? args.objectType
        : undefined;
    const patternFilter =
      typeof args?.pattern === "string" ? args.pattern.trim().toLowerCase() : "";
    const withDefinition = args?.withDefinition === true;
    const limitFilter =
      typeof args?.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(AI_AGENT_SCHEMA_OBJECTS_LIMIT, Math.max(1, Math.floor(args.limit)))
        : AI_AGENT_SCHEMA_OBJECTS_LIMIT;

    try {
      const objects = await invokeMutation<
        Array<{
          name: string;
          schema: string | null;
          object_type: string;
          related_table: string | null;
          definition: string | null;
        }>
      >("list_schema_objects", {
        connectionId: ctx.connectionId,
        database: ctx.currentDatabase ?? null,
      });
      if (ctx.requestId !== ctx.requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }
      const filtered = objects
        .filter((object) => (objectType ? object.object_type.toLowerCase() === objectType : true))
        .filter((object) =>
          patternFilter
            ? object.name.toLowerCase().includes(patternFilter) ||
              (object.related_table ?? "").toLowerCase().includes(patternFilter)
            : true,
        );
      const emit = (object: (typeof filtered)[number]) => ({
        name: object.name,
        schema: object.schema,
        objectType: object.object_type,
        relatedTable: object.related_table,
        definition:
          withDefinition && object.definition
            ? redactAgentSqlLiterals(
                object.definition.length > AI_AGENT_SCHEMA_OBJECT_DEFINITION_CHARS
                  ? `${object.definition.slice(0, AI_AGENT_SCHEMA_OBJECT_DEFINITION_CHARS)}\n[definition truncated]`
                  : object.definition,
              )
            : undefined,
      });
      return stringifyAgentObservation(frame, {
        objectType: objectType ?? "all",
        objectCount: filtered.length,
        truncated: filtered.length > limitFilter ? true : undefined,
        next:
          filtered.length > limitFilter
            ? `${filtered.length} objects exceed the ${limitFilter}-object preview. Narrow with args {"pattern":"substring"} or {"objectType":"view"}.`
            : undefined,
        objects: filtered.slice(0, limitFilter).map(emit),
        note: withDefinition
          ? undefined
          : "Set args.withDefinition=true to read the SQL definition of specific objects - it is verified business logic.",
      });
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      return agentToolError(`could not list schema objects: ${formatExecutionError(errorValue)}`, {
        retryable: isRetryableAgentToolError(errorValue),
      });
    }
  },
};
