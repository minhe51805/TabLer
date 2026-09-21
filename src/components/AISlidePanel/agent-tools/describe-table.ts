import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "../ai-agent-action-requestor";
import {
  findMatchingTableName,
  summarizeAgentStructureObservation,
  summarizeAgentSchemaSummaryObservation,
} from "../ai-agent-grounding";
import { AI_AGENT_BATCH_DESCRIBE_LIMIT } from "../ai-agent-tools";
import { agentToolError } from "../agent-tool-executor-helpers";
import { stringifyAgentObservation, type AgentToolContext, type AgentToolModule } from "./shared";

/** Normalizes the `table`/`tables` args into a deduped, capped name list. */
function requestedTableNames(args: Record<string, unknown>, allowSingle: boolean): string[] {
  const requestedTables: unknown[] = Array.isArray(args?.tables)
    ? args.tables
    : allowSingle && typeof args?.table === "string" && args.table.trim()
      ? [args.table]
      : [];
  return [
    ...new Set(
      requestedTables
        .filter(
          (value): value is string | number =>
            typeof value === "string" || typeof value === "number",
        )
        .map((value) => String(value).trim())
        .filter(Boolean),
    ),
  ].slice(0, AI_AGENT_BATCH_DESCRIBE_LIMIT);
}

/** Shared multi-table describe loop used by both describe_table and describe_tables. */
async function describeTableSections(ctx: AgentToolContext, names: string[]): Promise<string[]> {
  const sections: string[] = [];
  for (const requestedTable of names) {
    const matchedTable = findMatchingTableName(requestedTable, ctx.availableSchemaTables);
    if (!matchedTable) {
      sections.push(`TABLE=${requestedTable} ERROR=Not present in the current workspace schema.`);
      continue;
    }
    try {
      const cachedSummary = ctx.relationalSchemaSummaryByTable.get(matchedTable);
      if (cachedSummary) {
        ctx.inspectedAgentTables.add(matchedTable);
        sections.push(cachedSummary);
        continue;
      }
      const structure = await ctx.getTableStructure(
        ctx.connectionId!,
        matchedTable,
        ctx.currentDatabase || undefined,
      );
      if (ctx.requestId !== ctx.requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }
      ctx.inspectedAgentTables.add(matchedTable);
      sections.push(summarizeAgentStructureObservation(matchedTable, structure));
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      sections.push(`TABLE=${matchedTable} ERROR=${formatExecutionError(errorValue)}`);
    }
  }
  return sections;
}

export const tools: AgentToolModule[] = [
  {
    name: "describe_table",
    handler: async (ctx, args, frame) => {
      // Merged tool (was describe_table + describe_tables): accepts a single
      // `table` or a `tables` array (1..AI_AGENT_BATCH_DESCRIBE_LIMIT).
      const names = requestedTableNames(args, true);
      if (names.length === 0) {
        return agentToolError(
          "describe_table requires args.table or a non-empty args.tables array.",
          { hint: "Send args.table as one exact name, or args.tables as an array of names." },
        );
      }

      if (names.length === 1) {
        const matchedTable = findMatchingTableName(names[0], ctx.availableSchemaTables);
        if (!matchedTable) {
          return agentToolError(
            `Table "${names[0]}" is not present in the current workspace schema.`,
            { hint: ctx.tableNotFoundHint(names[0]) },
          );
        }

        const cachedSummary = ctx.relationalSchemaSummaryByTable.get(matchedTable);
        if (cachedSummary) {
          ctx.inspectedAgentTables.add(matchedTable);
          return summarizeAgentSchemaSummaryObservation(matchedTable, cachedSummary);
        }

        const structure = await ctx.getTableStructure(
          ctx.connectionId!,
          matchedTable,
          ctx.currentDatabase || undefined,
        );
        if (ctx.requestId !== ctx.requestIdRef.current) {
          throw new Error(AI_REQUEST_REPLACED_MESSAGE);
        }

        ctx.inspectedAgentTables.add(matchedTable);
        return summarizeAgentStructureObservation(matchedTable, structure);
      }

      const sections = await describeTableSections(ctx, names);
      return stringifyAgentObservation(frame, {
        described: sections.length,
        tables: sections.join("\n\n"),
      });
    },
  },
  {
    name: "describe_tables",
    handler: async (ctx, args, frame) => {
      const names = requestedTableNames(args, false);
      if (names.length === 0) {
        return agentToolError("describe_tables requires a non-empty args.tables array.", {
          hint: "Send args.tables as an array of exact table names.",
        });
      }

      const sections = await describeTableSections(ctx, names);
      return stringifyAgentObservation(frame, {
        described: sections.length,
        tables: sections.join("\n\n"),
      });
    },
  },
];
