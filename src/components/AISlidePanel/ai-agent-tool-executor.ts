import type { RefObject } from "react";
import type { ColumnDetail, QueryResult, TableInfo, TableStructure } from "../../types";
import { buildWorkspaceTableIdentifier } from "./ai-agent-context";
import { findAgentSchemaMatches, prioritizeSchemaScanCandidates } from "./ai-agent-schema-search";
import { formatExecutionError, isHighRiskStatement, isMutatingStatement, isSessionSwitchStatement } from "../SQLEditor/SQLEditorUtils";
import {
  findMatchingTableName,
  findSystemCatalogReferences,
  getAgentSqlSchemaRequirements,
  stringifyAgentObservation,
  summarizeAgentExplainPlan,
  summarizeAgentQueryObservation,
  summarizeAgentSchemaSummaryObservation,
  summarizeAgentStructureObservation,
} from "./ai-agent-grounding";
import { mapWithConcurrency } from "./ai-async-utils";
import {
  agentSqlToolBlockedMessage,
  type AgentToolAvailability,
} from "./ai-agent-engine-gates";
import {
  AI_AGENT_BATCH_DESCRIBE_LIMIT,
  AI_AGENT_SAMPLE_MAX_ROWS,
  validateAIAgentReadonlySql,
  type AIAgentToolAction,
} from "./ai-agent-tools";
import { saveSemanticGlossaryEntry } from "../../utils/semantic-glossary";
import { invokeMutation } from "../../utils/tauri-utils";
import {
  isSupersededAIRequestError,
  AI_REQUEST_REPLACED_MESSAGE,
} from "./ai-agent-action-requestor";

const MAX_AGENT_SCHEMA_SCAN_TABLES = 120;

export interface AgentToolExecutorDeps {
  connectionId: string | null;
  currentDatabase: string | null;
  latestTables: TableInfo[];
  availableSchemaTables: string[];
  relationalSchemaSummaryByTable: Map<string, string>;
  /** Mutated by describe/sample branches; shared with grounding downstream. */
  inspectedAgentTables: Set<string>;
  requestId: number;
  requestIdRef: RefObject<number>;
  requestDataReadConsent?: () => Promise<boolean>;
  publishAgentProgress: (pending?: { action: import("./ai-workspace-types").AIWorkspaceAgentActionName; message: string }) => void;
  getTableColumnsPreview: (connectionId: string, table: string, database?: string) => Promise<ColumnDetail[]>;
  getTableStructure: (connectionId: string, table: string, database?: string) => Promise<TableStructure>;
  getTableData: (
    connectionId: string,
    table: string,
    opts?: { database?: string; limit?: number },
  ) => Promise<QueryResult>;
  executeReadonlyQuery: (
    connectionId: string,
    statements: string[],
  ) => Promise<QueryResult>;
  previewWriteTransaction: (
    connectionId: string,
    statements: string[],
  ) => Promise<{ results: Array<{ affected_rows: number; rows: unknown[][]; truncated?: boolean }> }>;
  toolAvailability?: AgentToolAvailability;
}

/**
 * Tool-dispatch layer of the agent runtime. Executes each workspace tool
 * and returns a textual observation for the model. Includes an exploration
 * de-dupe guard so identical non-read calls do not burn step budget.
 * Extracted verbatim from use-ai-slide-panel.
 */

export function createAgentToolExecutor(deps: AgentToolExecutorDeps) {
  const {
    connectionId,
    currentDatabase,
    latestTables,
    availableSchemaTables,
    relationalSchemaSummaryByTable,
    inspectedAgentTables,
    requestId,
    requestIdRef,
    requestDataReadConsent,
    publishAgentProgress,
    getTableColumnsPreview,
    getTableStructure,
    getTableData,
    executeReadonlyQuery,
    previewWriteTransaction,
    toolAvailability,
  } = deps;
  let lastExplorationToolKey = "";

  const runAgentTool = async (action: AIAgentToolAction): Promise<string> => {
  try {
    // Repeating an exploration call with identical arguments returns the
    // identical observation and burns a step from a tight budget.
    const explorationKey = action.action !== "run_readonly_sql" && action.action !== "sample_table_data"
      ? `${action.action}:${JSON.stringify(action.args ?? {})}`
      : "";
    if (explorationKey && explorationKey === lastExplorationToolKey) {
      const varyHint = action.action === "list_tables"
        ? ' Narrow with args {"pattern":"substring"} or {"schema":"..."}, or raise {"limit":200}.'
        : " Vary the arguments or move on to the next step.";
      return `Tool notice: identical ${action.action} call repeated — vary the arguments or continue.${varyHint}`;
    }
    if (explorationKey) {
      lastExplorationToolKey = explorationKey;
    }

    if (action.action === "list_tables") {
      const schemaFilter = typeof action.args?.schema === "string" ? action.args.schema.trim().toLowerCase() : "";
      const patternFilter = typeof action.args?.pattern === "string" ? action.args.pattern.trim().toLowerCase() : "";
      const limitFilter = typeof action.args?.limit === "number" && Number.isFinite(action.args.limit)
        ? Math.min(200, Math.max(1, Math.floor(action.args.limit)))
        : 200;
      const minRowsFilter = typeof action.args?.minRows === "number" && Number.isFinite(action.args.minRows)
        ? Math.max(1, Math.floor(action.args.minRows))
        : undefined;

      const filteredTables = latestTables.filter((table) => {
        const identifier = (buildWorkspaceTableIdentifier(table, currentDatabase) || table.name).toLowerCase();
        if (schemaFilter && (table.schema ?? "").toLowerCase() !== schemaFilter) return false;
        if (patternFilter && !identifier.includes(patternFilter) && !table.name.toLowerCase().includes(patternFilter)) {
          return false;
        }
        if (minRowsFilter !== undefined && (table.row_count ?? 0) < minRowsFilter) return false;
        return true;
      });

      return stringifyAgentObservation({
        database: currentDatabase || "Default",
        catalogTables: latestTables.length,
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
          identifier: buildWorkspaceTableIdentifier(table, currentDatabase),
          type: table.table_type,
          rowCount: table.row_count ?? null,
        })),
      });
    }

    if (action.action === "search_schema") {
      const query = typeof action.args?.query === "string" ? action.args.query.trim() : "";
      if (!query) {
        return "Tool error: search_schema requires args.query.";
      }

      // Column-scanning every table means hundreds of metadata queries
      // on large catalogs, so prioritize name matches and cap the scan.
      const catalogEntries = latestTables.map((table) => ({
        identifier: buildWorkspaceTableIdentifier(table, currentDatabase) || table.name,
      }));
      const prioritizedIdentifiers = new Set(
        prioritizeSchemaScanCandidates(
          catalogEntries.map((entry) => entry.identifier),
          query,
          MAX_AGENT_SCHEMA_SCAN_TABLES,
        ),
      );
      const scanEntries = catalogEntries.filter((entry) => prioritizedIdentifiers.has(entry.identifier));

      let scannedCount = 0;
      const scanned = await mapWithConcurrency(scanEntries, 4, async (entry) => {
        try {
          const columns = await getTableColumnsPreview(
            connectionId!,
            entry.identifier,
            currentDatabase || undefined,
          );
          return { identifier: entry.identifier, columns, failed: false };
        } catch {
          return { identifier: entry.identifier, columns: [], failed: true };
        } finally {
          scannedCount += 1;
          if (scanEntries.length > 24 && scannedCount % 24 === 0) {
            publishAgentProgress({
              action: "search_schema",
              message: `Scanning schema (${scannedCount}/${scanEntries.length})`,
            });
          }
        }
      });
      if (requestId !== requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }

      const matches = findAgentSchemaMatches(query, scanned);
      return stringifyAgentObservation({
        query,
        catalogTables: catalogEntries.length,
        tablesScanned: scanned.length,
        tablesFailed: scanned.filter((entry) => entry.failed).length,
        truncatedCatalog:
          scanned.length < catalogEntries.length
            ? `Only the ${scanned.length} tables whose names best match the query were scanned; ${catalogEntries.length - scanned.length} were skipped.`
            : undefined,
        matches,
        next: matches.length > 0
          ? "Call describe_table for the best matching table, then read the requested row data."
          : "No matching columns were found in the scanned catalog. Do not claim a column is absent if tablesFailed is greater than zero.",
      });
    }

    if (action.action === "describe_table") {
      const requestedTable = typeof action.args?.table === "string" ? action.args.table.trim() : "";
      if (!requestedTable) {
        return "Tool error: describe_table requires args.table.";
      }

      const matchedTable = findMatchingTableName(requestedTable, availableSchemaTables);
      if (!matchedTable) {
        return `Tool error: Table "${requestedTable}" is not present in the current workspace schema.`;
      }

      const cachedSummary = relationalSchemaSummaryByTable.get(matchedTable);
      if (cachedSummary) {
        inspectedAgentTables.add(matchedTable);
        return summarizeAgentSchemaSummaryObservation(matchedTable, cachedSummary);
      }

      const structure = await getTableStructure(connectionId!, matchedTable, currentDatabase || undefined);
      if (requestId !== requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }

      inspectedAgentTables.add(matchedTable);
      return summarizeAgentStructureObservation(matchedTable, structure);
    }

    if (action.action === "describe_tables") {
      const requestedTables: unknown[] = Array.isArray(action.args?.tables) ? action.args.tables : [];
      const names = [...new Set(
        requestedTables
          .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
          .map((value) => String(value).trim())
          .filter(Boolean),
      )].slice(0, AI_AGENT_BATCH_DESCRIBE_LIMIT);
      if (names.length === 0) {
        return "Tool error: describe_tables requires a non-empty args.tables array.";
      }

      const sections: string[] = [];
      for (const requestedTable of names) {
        const matchedTable = findMatchingTableName(requestedTable, availableSchemaTables);
        if (!matchedTable) {
          sections.push(`TABLE=${requestedTable} ERROR=Not present in the current workspace schema.`);
          continue;
        }
        try {
          const cachedSummary = relationalSchemaSummaryByTable.get(matchedTable);
          if (cachedSummary) {
            inspectedAgentTables.add(matchedTable);
            sections.push(cachedSummary);
            continue;
          }
          const structure = await getTableStructure(connectionId!, matchedTable, currentDatabase || undefined);
          if (requestId !== requestIdRef.current) {
            throw new Error(AI_REQUEST_REPLACED_MESSAGE);
          }
          inspectedAgentTables.add(matchedTable);
          sections.push(summarizeAgentStructureObservation(matchedTable, structure));
        } catch (errorValue) {
          if (isSupersededAIRequestError(errorValue)) throw errorValue;
          sections.push(`TABLE=${matchedTable} ERROR=${formatExecutionError(errorValue)}`);
        }
      }

      return stringifyAgentObservation({
        described: sections.length,
        tables: sections.join("\n\n"),
      });
    }

    if (action.action === "sample_table_data") {
      const requestedTable = typeof action.args?.table === "string" ? action.args.table.trim() : "";
      if (!requestedTable) {
        return "Tool error: sample_table_data requires args.table.";
      }

      const matchedTable = findMatchingTableName(requestedTable, availableSchemaTables);
      if (!matchedTable) {
        return `Tool error: Table "${requestedTable}" is not present in the current workspace schema.`;
      }

      if (requestDataReadConsent) {
        const approved = await requestDataReadConsent();
        if (!approved) {
          return "Tool blocked: The user did not grant permission to read live database rows for this request.";
        }
      }

      const requestedLimit = typeof action.args?.limit === "number" && Number.isFinite(action.args.limit)
        ? Math.min(AI_AGENT_SAMPLE_MAX_ROWS, Math.max(1, Math.floor(action.args.limit)))
        : 10;
      // get_table_data goes through the engine driver so identifiers are
      // quoted per dialect; no model-supplied SQL is involved here.
      const queryResult = await getTableData(connectionId!, matchedTable, {
        database: currentDatabase || undefined,
        limit: requestedLimit,
      });
      if (requestId !== requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }

      inspectedAgentTables.add(matchedTable);
      return summarizeAgentQueryObservation(queryResult);
    }

    if (action.action === "run_readonly_sql") {
      if (toolAvailability && !toolAvailability.sqlRead) {
        return agentSqlToolBlockedMessage("run_readonly_sql", toolAvailability);
      }
      const sql = typeof action.args?.sql === "string" ? action.args.sql.trim() : "";
      if (!sql) {
        return "Tool error: run_readonly_sql requires args.sql.";
      }

      // First-line defense: reject mutations/session SQL before any backend
      // call. The dedicated `execute_agent_readonly_query` command still pins
      // read-only server-side; this is fail-fast UX, not the security boundary.
      try {
        validateAIAgentReadonlySql(sql);
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return `Tool error: ${errorValue instanceof Error ? errorValue.message : String(errorValue)}`;
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
        availableSchemaTables,
        inspectedAgentTables,
      );
      if (schemaRequirements.unknown.length > 0) {
        return `Tool blocked: SQL references unknown table(s): ${schemaRequirements.unknown.join(", ")}. Use list_tables and describe_table first.`;
      }
      if (schemaRequirements.uninspected.length > 0) {
        return `Tool blocked: Inspect the schema before reading rows. Call describe_table for: ${schemaRequirements.uninspected.join(", ")}.`;
      }

      if (requestDataReadConsent) {
        const approved = await requestDataReadConsent();
        if (!approved) {
          return "Tool blocked: The user did not grant permission to read live database rows for this request.";
        }
      }

      // Heavy-read guard: an unbounded SELECT gets an automatic EXPLAIN
      // first so the model sees scan estimates before pulling data.
      let explainNote = "";
      if (
        /^(SELECT|WITH)\b/i.test(sql)
        && !/\bLIMIT\s+\d/i.test(sql)
        && !/^EXPLAIN\b/i.test(sql)
      ) {
        try {
          const plan = await executeReadonlyQuery(connectionId!, [`EXPLAIN ${sql}`]);
          const planText = summarizeAgentExplainPlan(plan);
          if (planText) {
            explainNote = `\n\nQuery plan (EXPLAIN, not executed):\n${planText}`;
          }
        } catch (errorValue) {
          if (isSupersededAIRequestError(errorValue)) throw errorValue;
          // Engines without EXPLAIN support simply skip the cost preview.
        }
        if (requestId !== requestIdRef.current) {
          throw new Error(AI_REQUEST_REPLACED_MESSAGE);
        }
      }

      const queryResult = await executeReadonlyQuery(connectionId!, [sql]);
      if (requestId !== requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }

      return `${summarizeAgentQueryObservation(queryResult)}${explainNote}`;
    }

    if (action.action === "preview_write") {
      if (toolAvailability && !toolAvailability.sqlWritePreview) {
        return agentSqlToolBlockedMessage("preview_write", toolAvailability);
      }
      const requested = Array.isArray(action.args?.statements) ? action.args.statements : [];
      const statements = requested
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean);
      if (statements.length === 0) {
        return "Tool error: preview_write requires a non-empty args.statements array.";
      }

      // Safety rails: at least one real change, no session switching,
      // and explicit user consent before touching live rows.
      const mutatingCount = statements.filter(
        (statement) => isMutatingStatement(statement) || isHighRiskStatement(statement),
      ).length;
      if (mutatingCount === 0) {
        return "Tool error: preview_write requires at least one INSERT/UPDATE/DELETE/ALTER/CREATE statement. Use run_readonly_sql for reads.";
      }
      for (const statement of statements) {
        if (isSessionSwitchStatement(statement)) {
          return "Tool blocked: session-switch statements are not allowed in write previews.";
        }
      }

      if (requestDataReadConsent) {
        const approved = await requestDataReadConsent();
        if (!approved) {
          return "Tool blocked: The user did not grant permission to run the write preview for this request.";
        }
      }

      try {
        const preview = await previewWriteTransaction(connectionId!, statements);
        const summary = preview.results.map((result, index) => ({
          statement: statements[index] ?? `statement ${index + 1}`,
          affectedRows: result.affected_rows,
          returnedRows: result.rows.length,
          truncated: result.truncated || undefined,
        }));
        return stringifyAgentObservation({
          rolledBack: true,
          persisted: false,
          note: "Executed inside one transaction and ROLLED BACK. Nothing was saved. Report these effects as a PREVIEW and direct the user to apply the final SQL through the approval flow.",
          statementCount: statements.length,
          results: summary,
        });
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return `Tool error: ${formatExecutionError(errorValue)}`;
      }
    }

    if (action.action === "remember_term") {
      const term = typeof action.args?.term === "string" ? action.args.term.trim() : "";
      const definition = typeof action.args?.definition === "string" ? action.args.definition.trim() : "";
      if (!term || !definition) {
        return "Tool error: remember_term requires args.term and args.definition.";
      }
      try {
        await saveSemanticGlossaryEntry({
          connectionId: connectionId!,
          database: currentDatabase || undefined,
          term,
          definition,
          kind: action.args?.kind,
          source: "agent",
        });
        return stringifyAgentObservation({
          saved: term,
          definition,
          note: "Saved to the business glossary; future runs for this database will see it automatically.",
        });
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return `Tool error: could not save the glossary entry: ${formatExecutionError(errorValue)}`;
      }
    }

    if (action.action === "skill") {
      const skillName = typeof action.args?.name === "string" ? action.args.name.trim() : "";
      if (!skillName) {
        return "Tool error: skill requires args.name taken from the <available_skills> list.";
      }
      try {
        const content = await invokeMutation<{ name: string; body: string }>("read_ai_skill", {
          name: skillName,
        });
        return [
          `Skill "${content.name}" loaded. Follow these instructions for the remainder of the run:`,
          "",
          content.body,
        ].join("\n");
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return `Tool error: could not load skill "${skillName}": ${formatExecutionError(errorValue)}`;
      }
    }

    return "Tool error: finish does not execute a tool observation.";
  } catch (errorValue) {
    if (isSupersededAIRequestError(errorValue)) {
      throw errorValue;
    }
    return `Tool error: ${formatExecutionError(errorValue)}`;
  }
};

  return { runAgentTool };
}
