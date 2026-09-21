import { AI_REQUEST_REPLACED_MESSAGE } from "../ai-agent-action-requestor";
import { buildWorkspaceTableIdentifier } from "../ai-agent-context";
import { findAgentSchemaMatches, prioritizeSchemaScanCandidates } from "../ai-agent-schema-search";
import { mapWithConcurrency } from "../ai-async-utils";
import { agentToolError } from "../agent-tool-executor-helpers";
import { stringifyAgentObservation, type AgentToolModule } from "./shared";

const MAX_AGENT_SCHEMA_SCAN_TABLES = 120;

export const tool: AgentToolModule = {
  name: "search_schema",
  handler: async (ctx, args, frame) => {
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    if (!query) {
      return agentToolError("search_schema requires args.query.", {
        hint: 'Send args.query with the column name or concept to locate, e.g. {"query":"email"}.',
      });
    }

    // Column-scanning every table means hundreds of metadata queries
    // on large catalogs, so prioritize name matches and cap the scan.
    const catalogEntries = ctx.latestTables.map((table) => ({
      identifier: buildWorkspaceTableIdentifier(table, ctx.currentDatabase) || table.name,
    }));
    const prioritizedIdentifiers = new Set(
      prioritizeSchemaScanCandidates(
        catalogEntries.map((entry) => entry.identifier),
        query,
        MAX_AGENT_SCHEMA_SCAN_TABLES,
      ),
    );
    const scanEntries = catalogEntries.filter((entry) =>
      prioritizedIdentifiers.has(entry.identifier),
    );

    let scannedCount = 0;
    const scanned = await mapWithConcurrency(scanEntries, 4, async (entry) => {
      try {
        const columns = await ctx.getTableColumnsPreview(
          ctx.connectionId!,
          entry.identifier,
          ctx.currentDatabase || undefined,
        );
        return { identifier: entry.identifier, columns, failed: false };
      } catch {
        return { identifier: entry.identifier, columns: [], failed: true };
      } finally {
        scannedCount += 1;
        if (scanEntries.length > 24 && scannedCount % 24 === 0) {
          ctx.publishAgentProgress({
            action: "search_schema",
            message: `Scanning schema (${scannedCount}/${scanEntries.length})`,
          });
        }
      }
    });
    if (ctx.requestId !== ctx.requestIdRef.current) {
      throw new Error(AI_REQUEST_REPLACED_MESSAGE);
    }

    const matches = findAgentSchemaMatches(query, scanned);
    return stringifyAgentObservation(frame, {
      query,
      catalogTables: catalogEntries.length,
      tablesScanned: scanned.length,
      tablesFailed: scanned.filter((entry) => entry.failed).length,
      truncatedCatalog:
        scanned.length < catalogEntries.length
          ? `Only the ${scanned.length} tables whose names best match the query were scanned; ${catalogEntries.length - scanned.length} were skipped.`
          : undefined,
      matches,
      next:
        matches.length > 0
          ? "Call describe_table for the best matching table, then read the requested row data."
          : "No matching columns were found in the scanned catalog. Do not claim a column is absent if tablesFailed is greater than zero.",
    });
  },
};
