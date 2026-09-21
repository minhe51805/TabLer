import { buildWorkspaceTableIdentifier } from "../ai-agent-context";
import { stringifyAgentObservation, type AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "list_tables",
  handler: async (ctx, args, frame) => {
    const schemaFilter = typeof args?.schema === "string" ? args.schema.trim().toLowerCase() : "";
    const patternFilter =
      typeof args?.pattern === "string" ? args.pattern.trim().toLowerCase() : "";
    const limitFilter =
      typeof args?.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(200, Math.max(1, Math.floor(args.limit)))
        : 200;
    const minRowsFilter =
      typeof args?.minRows === "number" && Number.isFinite(args.minRows)
        ? Math.max(1, Math.floor(args.minRows))
        : undefined;

    const filteredTables = ctx.latestTables.filter((table) => {
      const identifier = (
        buildWorkspaceTableIdentifier(table, ctx.currentDatabase) || table.name
      ).toLowerCase();
      if (schemaFilter && (table.schema ?? "").toLowerCase() !== schemaFilter) return false;
      if (
        patternFilter &&
        !identifier.includes(patternFilter) &&
        !table.name.toLowerCase().includes(patternFilter)
      ) {
        return false;
      }
      if (minRowsFilter !== undefined && (table.row_count ?? 0) < minRowsFilter) return false;
      return true;
    });

    return stringifyAgentObservation(frame, {
      database: ctx.currentDatabase || "Default",
      catalogTables: ctx.latestTables.length,
      filtered: schemaFilter || patternFilter ? true : undefined,
      minRows: minRowsFilter,
      tableCount: filteredTables.length,
      truncated: filteredTables.length > limitFilter ? true : undefined,
      next:
        filteredTables.length > limitFilter
          ? `${filteredTables.length} tables exceed the ${limitFilter}-name preview. Narrow with args {"pattern":"substring"} or {"schema":"..."}, or raise {"limit":200}.`
          : undefined,
      tables: filteredTables.slice(0, limitFilter).map((table) => ({
        name: table.name,
        schema: table.schema ?? null,
        identifier: buildWorkspaceTableIdentifier(table, ctx.currentDatabase),
        type: table.table_type,
        rowCount: table.row_count ?? null,
      })),
    });
  },
};
