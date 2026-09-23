import type { QueryResult } from "../../../types";
import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "../ai-agent-action-requestor";
import { agentSqlToolBlockedMessage } from "../ai-agent-engine-gates";
import { appendAgentFacts } from "../ai-agent-context";
import {
  findSystemCatalogReferences,
  getAgentSqlSchemaRequirements,
  summarizeAgentExplainPlanStructured,
  summarizeAgentQueryObservation,
} from "../ai-agent-grounding";
import { validateAIAgentReadonlySql } from "../ai-agent-tools";
import { classifyAgentSqlReadonly } from "../agent-tool-executor-helpers";
import {
  agentQueryTimeoutHint,
  agentSqlErrorHint,
  agentToolError,
  isRetryableAgentToolError,
} from "../agent-tool-executor-helpers";
import type { AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "run_readonly_sql",
  handler: async (ctx, args) => {
    if (ctx.toolAvailability && !ctx.toolAvailability.sqlRead) {
      return agentSqlToolBlockedMessage("run_readonly_sql", ctx.toolAvailability);
    }
    const sql = typeof args?.sql === "string" ? args.sql.trim() : "";
    if (!sql) {
      return agentToolError("run_readonly_sql requires args.sql.", {
        hint: 'Send args.sql as a single read-only statement, e.g. {"sql":"SELECT ... LIMIT 50"}.',
      });
    }

    // First-line defense: reject mutations/session SQL before any backend
    // call. The dedicated `execute_agent_readonly_query` command still pins
    // read-only server-side; this is fail-fast UX, not the security boundary.
    try {
      validateAIAgentReadonlySql(sql);
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      return agentToolError(errorValue instanceof Error ? errorValue.message : String(errorValue), {
        hint: "Only SELECT/SHOW/EXPLAIN/DESCRIBE/WITH/read-only PRAGMA statements are allowed.",
      });
    }

    // Second-line defense: the backend classifier sees through
    // `EXPLAIN ANALYZE <write>` and dialect constructs the prefix guard
    // cannot — anything it does not call read-only is rejected here.
    const backendGuard = await classifyAgentSqlReadonly(sql, ctx.dbType);
    if (!backendGuard.ok) {
      return `Tool blocked: ${backendGuard.error}`;
    }

    // System catalogs have engine-specific columns and are the #1 source of
    // hallucinated SQL (e.g. information_schema.tables has no row_count).
    // The workspace tools already provide everything the catalogs would.
    const catalogRefs = findSystemCatalogReferences(sql);
    if (catalogRefs.length > 0) {
      return `Tool blocked: SQL references system catalog objects (${catalogRefs.join(", ")}). Do not query information_schema/pg_catalog/sqlite_master — their columns vary per engine. For table lists and row counts use list_tables (each entry carries rowCount); for columns use search_schema or describe_table.`;
    }

    const schemaRequirements = getAgentSqlSchemaRequirements(
      sql,
      ctx.availableSchemaTables,
      ctx.inspectedAgentTables,
    );
    if (schemaRequirements.unknown.length > 0) {
      return `Tool blocked: SQL references unknown table(s): ${schemaRequirements.unknown.join(", ")}. Use list_tables and describe_table first.`;
    }
    if (schemaRequirements.uninspected.length > 0) {
      return `Tool blocked: Inspect the schema before reading rows. Call describe_table for: ${schemaRequirements.uninspected.join(", ")}.`;
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

    // Heavy-read guard: an unbounded SELECT gets an automatic EXPLAIN
    // first so the model sees scan estimates before pulling data.
    let explainNote = "";
    if (/^(SELECT|WITH)\b/i.test(sql) && !/\bLIMIT\s+\d/i.test(sql) && !/^EXPLAIN\b/i.test(sql)) {
      try {
        const plan = await ctx.executeReadonlyQuery(ctx.connectionId!, [`EXPLAIN ${sql}`]);
        const planText = summarizeAgentExplainPlanStructured(plan, ctx.dbType);
        if (planText) {
          explainNote = `\n\nQuery plan (EXPLAIN, not executed - structured summary with cost hotspots):\n${planText}`;
        }
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        // Engines without EXPLAIN support simply skip the cost preview.
      }
      if (ctx.requestId !== ctx.requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }
    }
    if (ctx.requestId !== ctx.requestIdRef.current) {
      throw new Error(AI_REQUEST_REPLACED_MESSAGE);
    }

    let queryResult: QueryResult;
    try {
      queryResult = await ctx.executeReadonlyQuery(ctx.connectionId!, [sql]);
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      // A timed-out query is actionable feedback, not a dead end: tell
      // the model exactly how to shrink the statement.
      return agentToolError(`readonly query failed: ${formatExecutionError(errorValue)}`, {
        hint:
          agentSqlErrorHint(errorValue) ?? (agentQueryTimeoutHint(errorValue).trim() || undefined),
        retryable: isRetryableAgentToolError(errorValue),
      });
    }
    if (ctx.requestId !== ctx.requestIdRef.current) {
      throw new Error(AI_REQUEST_REPLACED_MESSAGE);
    }

    return appendAgentFacts(`${summarizeAgentQueryObservation(queryResult)}${explainNote}`, {
      rowsReturned: queryResult.rows.length,
      // The statement that ran, for the insight engine: `sql` is exactly
      // what executeReadonlyQuery received above.
      insightEvidence: { executedSql: sql, rowCount: queryResult.rows.length },
    });
  },
};
