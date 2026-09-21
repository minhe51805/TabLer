import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "../ai-agent-action-requestor";
import {
  appendAgentFacts,
  buildWorkspaceTableIdentifier,
  type AgentStepEvidence,
} from "../ai-agent-context";
import { findMatchingTableName, summarizeAgentQueryObservation } from "../ai-agent-grounding";
import { AI_AGENT_SAMPLE_MAX_ROWS } from "../ai-agent-tools";
import {
  agentSqlQuoteIdentifier,
  agentToolError,
  computeSampleColumnStats,
  resolveColumnStatsScope,
} from "../agent-tool-executor-helpers";
import type { AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "sample_table_data",
  handler: async (ctx, args) => {
    const requestedTable = typeof args?.table === "string" ? args.table.trim() : "";
    if (!requestedTable) {
      return agentToolError("sample_table_data requires args.table.", {
        hint: "Send args.table as one exact table name from list_tables.",
      });
    }

    const matchedTable = findMatchingTableName(requestedTable, ctx.availableSchemaTables);
    if (!matchedTable) {
      return agentToolError(
        `Table "${requestedTable}" is not present in the current workspace schema.`,
        { hint: ctx.tableNotFoundHint(requestedTable) },
      );
    }

    if (ctx.requestDataReadConsent) {
      const approved = await ctx.requestDataReadConsent();
      if (!approved) {
        return "Tool blocked: The user did not grant permission to read live database rows for this request.";
      }
    }

    const requestedLimit =
      typeof args?.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(AI_AGENT_SAMPLE_MAX_ROWS, Math.max(1, Math.floor(args.limit)))
        : 10;
    const requestedOffset =
      typeof args?.offset === "number" && Number.isFinite(args.offset)
        ? Math.max(0, Math.floor(args.offset))
        : 0;
    // get_table_data goes through the engine driver so identifiers are
    // quoted per dialect; no model-supplied SQL is involved here.
    const queryResult = await ctx.getTableData(ctx.connectionId!, matchedTable, {
      database: ctx.currentDatabase || undefined,
      limit: requestedLimit,
      offset: requestedOffset || undefined,
    });
    if (ctx.requestId !== ctx.requestIdRef.current) {
      throw new Error(AI_REQUEST_REPLACED_MESSAGE);
    }

    ctx.inspectedAgentTables.add(matchedTable);

    // Column-statistics enrichment, GATED (audit fix: this used to run a
    // COUNT/SUM/COUNT(DISTINCT) aggregate over the WHOLE table on every
    // sample). Whole-table stats only run when the catalog rowCount is
    // known and at most AI_AGENT_COLUMN_STATS_MAX_TABLE_ROWS; anything
    // bigger — or of unknown size — computes stats from the sampled rows
    // instead, and args.stats="off" skips them entirely. Failures are
    // silent: the sample itself remains the source of truth.
    const statColumns = queryResult.columns.slice(0, 12);
    const matchedCatalogTable = ctx.latestTables.find(
      (table) =>
        table.name === matchedTable ||
        buildWorkspaceTableIdentifier(table, ctx.currentDatabase) === matchedTable,
    );
    const knownRowCount = matchedCatalogTable?.row_count ?? null;
    const statsScope = resolveColumnStatsScope(
      typeof args?.stats === "string" ? args.stats : undefined,
      knownRowCount,
    );
    let columnStats:
      Array<{ column: string; nullRatio: number; distinctCount: number }> | undefined;
    let columnStatsScopeLabel = "";
    let insightEvidence: AgentStepEvidence | undefined;
    if (statsScope !== "off" && statColumns.length > 0 && requestedOffset === 0) {
      if (statsScope === "whole") {
        try {
          const quotedTable = agentSqlQuoteIdentifier(ctx.dbType, matchedTable);
          const selectParts = [
            "COUNT(*) AS __total",
            ...statColumns.flatMap((column, index) => {
              const quoted = agentSqlQuoteIdentifier(ctx.dbType, column.name);
              return [
                `SUM(CASE WHEN ${quoted} IS NULL THEN 1 ELSE 0 END) AS __null_${index}`,
                `COUNT(DISTINCT ${quoted}) AS __distinct_${index}`,
              ];
            }),
          ];
          const statsSql = `SELECT ${selectParts.join(", ")} FROM ${quotedTable}`;
          const statsResult = await ctx.executeReadonlyQuery(ctx.connectionId!, [statsSql]);
          if (ctx.requestId !== ctx.requestIdRef.current) {
            throw new Error(AI_REQUEST_REPLACED_MESSAGE);
          }
          const row = statsResult.rows[0];
          const total = Number(row?.[0] ?? 0);
          if (Number.isFinite(total) && total > 0) {
            columnStats = statColumns.map((column, index) => {
              const nullCount = Number(row?.[1 + index * 2] ?? 0);
              const distinctCount = Number(row?.[2 + index * 2] ?? 0);
              return {
                column: column.name,
                nullRatio: Math.round((nullCount / total) * 1000) / 1000,
                distinctCount: Number.isFinite(distinctCount) ? distinctCount : 0,
              };
            });
            columnStatsScopeLabel = " (whole table)";
            // This aggregate is the statement the numbers above came from,
            // so the insight engine may cite it. Sample-scoped stats carry
            // no evidence on purpose: that read is driver-side pagination,
            // no SQL text for it exists here, and inventing one would
            // fabricate the proof an insight is required to show.
            insightEvidence = { executedSql: statsSql, rowCount: total };
          }
        } catch (errorValue) {
          if (isSupersededAIRequestError(errorValue)) throw errorValue;
          // Statistics are best-effort; engine quirks must not break sampling.
        }
      } else {
        // Sample-scoped stats: computed in memory from the rows this call
        // already fetched — no extra query, never a full-table read.
        columnStats = computeSampleColumnStats(
          queryResult.rows,
          statColumns.map((column, index) => ({ name: column.name, index })),
        );
        if (columnStats.length > 0) {
          columnStatsScopeLabel = ` (sample of ${queryResult.rows.length} rows)`;
        }
      }
    }

    const observation = summarizeAgentQueryObservation(queryResult);
    return appendAgentFacts(
      columnStats
        ? `${observation}\n\nColumn stats${columnStatsScopeLabel}: ${columnStats
            .map(
              (stat) =>
                `${stat.column}: nullRatio=${stat.nullRatio}, distinct=${stat.distinctCount}`,
            )
            .join(" | ")}`
        : observation,
      {
        rowsReturned: queryResult.rows.length,
        tables: [matchedTable],
        ...(columnStats ? { columnStats } : {}),
        ...(insightEvidence ? { insightEvidence } : {}),
      },
    );
  },
};
