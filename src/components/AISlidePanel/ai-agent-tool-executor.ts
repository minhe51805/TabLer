import type { RefObject } from "react";
import type { ColumnDetail, DatabaseType, QueryParameterType, QueryResult, TableInfo, TableStructure } from "../../types";
import {
  appendAgentFacts,
  buildWorkspaceTableIdentifier,
} from "./ai-agent-context";
import { findAgentSchemaMatches, prioritizeSchemaScanCandidates } from "./ai-agent-schema-search";
import { formatExecutionError, isHighRiskStatement, isMutatingStatement, isSessionSwitchStatement, normalizeStatementForGuard } from "../SQLEditor/SQLEditorUtils";
import {
  findMatchingTableName,
  findSystemCatalogReferences,
  getAgentSqlSchemaRequirements,
  redactAgentSqlLiterals,
  stringifyAgentObservationFull,
  summarizeAgentExplainPlanStructured,
  summarizeAgentQueryObservation,
  summarizeAgentSchemaSummaryObservation,
  summarizeAgentStructureObservation,
  truncateAgentObservation,
} from "./ai-agent-grounding";
import { mapWithConcurrency } from "./ai-async-utils";
import {
  agentSqlToolBlockedMessage,
  type AgentToolAvailability,
} from "./ai-agent-engine-gates";
import {
  AI_AGENT_BATCH_DESCRIBE_LIMIT,
  AI_AGENT_COLUMN_STATS_MAX_TABLE_ROWS,
  AI_AGENT_DELEGATE_ANSWER_CHARS,
  AI_AGENT_DELEGATE_FOCUS_TABLES_LIMIT,
  AI_AGENT_DELEGATE_MAX_CALLS,
  AI_AGENT_PLAN_STEP_LIMIT,
  AI_AGENT_READ_PAGE_MAX_CHARS,
  AI_AGENT_SAMPLE_MAX_ROWS,
  AI_AGENT_SCHEMA_OBJECTS_LIMIT,
  AI_AGENT_SCHEMA_OBJECT_DEFINITION_CHARS,
  validateAIAgentReadonlySql,
  type AIAgentToolAction,
  AI_AGENT_TOOL_NAMES,
} from "./ai-agent-tools";
import { getAdminQueryPreset, type AdminQueryKind } from "../../utils/admin-query-presets";
import { saveSemanticGlossaryEntry } from "../../utils/semantic-glossary";
import { requestAICheckpointPick } from "./ai-checkpoint-picker";
import { useSkillUsageStore } from "../../stores/skillUsageStore";
import { useUIStore } from "../../stores/uiStore";
import { invokeMutation } from "../../utils/tauri-utils";
import { EventCenter } from "../../stores/event-center";
import {
  isSupersededAIRequestError,
  AI_REQUEST_REPLACED_MESSAGE,
} from "./ai-agent-action-requestor";

const MAX_AGENT_SCHEMA_SCAN_TABLES = 120;

/**
 * Appended to SQL tool errors when the database itself gave up on the
 * statement (timeout). A timeout is actionable feedback: the model can run a
 * narrower statement instead of concluding the table is unreadable.
 */
function agentQueryTimeoutHint(errorValue: unknown): string {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  return /timed?\s*out/i.test(message)
    ? " The database gave up on this query. Run a narrower statement instead: filter on a key column, select only the needed columns, and add a LIMIT."
    : "";
}

/** Scope of the sample_table_data column-statistics enrichment. */
export type AgentColumnStatsScope = "whole" | "sample" | "off";

const AGENT_PLAN_STATUSES = new Set(["pending", "in_progress", "done"]);

/**
 * Sanitizes raw update_plan `args.steps` into a bounded, status-valid
 * checklist: non-object entries and blank titles are dropped, statuses fall
 * back to "pending", titles are capped, and the list is truncated to the
 * schema maximum. Exported pure for the golden-set eval.
 */
export function normalizeAgentPlanSteps(
  raw: unknown,
  maxSteps: number,
): import("./ai-agent-context").AgentPlanStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: import("./ai-agent-context").AgentPlanStep[] = [];
  for (const entry of raw) {
    if (steps.length >= maxSteps) break;
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) continue;
    const status = typeof record.status === "string" && AGENT_PLAN_STATUSES.has(record.status)
      ? record.status as import("./ai-agent-context").AgentPlanStep["status"]
      : "pending";
    steps.push({ title: title.slice(0, 160), status });
  }
  return steps;
}

/**
 * Resolves how sample_table_data computes column statistics. "whole" runs one
 * aggregate over every row in the table — only safe when the catalog rowCount
 * is known and small. Large or unknown-size tables use "sample" (stats from
 * the rows already fetched) so a peek can never become a full-table scan.
 */
export function resolveColumnStatsScope(
  requested: string | undefined,
  knownRowCount: number | null,
): AgentColumnStatsScope {
  if (requested === "off") return "off";
  if (requested === "sample") return "sample";
  return knownRowCount !== null && knownRowCount <= AI_AGENT_COLUMN_STATS_MAX_TABLE_ROWS
    ? "whole"
    : "sample";
}

/**
 * Column statistics computed in memory from an already-fetched result page —
 * the honest fallback for tables too big (or of unknown size) for a
 * whole-table aggregate. Rows are positional, matching QueryResult.rows.
 */
export function computeSampleColumnStats(
  rows: Array<Array<string | number | boolean | null>>,
  columns: Array<{ name: string; index: number }>,
): Array<{ column: string; nullRatio: number; distinctCount: number }> {
  const total = rows.length;
  if (total === 0) return [];
  return columns.map(({ name, index }) => {
    const distinct = new Set<string>();
    let nullCount = 0;
    for (const row of rows) {
      const value = row[index];
      if (value === null || value === undefined || value === "") {
        nullCount += 1;
        continue;
      }
      distinct.add(String(value));
    }
    return {
      column: name,
      nullRatio: Math.round((nullCount / total) * 1000) / 1000,
      distinctCount: distinct.size,
    };
  });
}

export interface AgentToolExecutorDeps {
  connectionId: string | null;
  /** Names injected in this run's <available_skills> catalog. When set, the
   * skill tool refuses anything outside the list so "injected == loadable"
   * stays true even if the catalog is later filtered or capped. */
  allowedSkillNames?: string[];
  /** Scope for the agent-memory store (read_memory/save_memory tools). Memory
   * is keyed by connection+database — the same scope as the glossary — so a
   * different connection or database can never see another's memories. */
  memoryScope?: { connectionId: string | null; database: string | null };
  currentDatabase: string | null;
  dbType?: DatabaseType;
  latestTables: TableInfo[];
  availableSchemaTables: string[];
  relationalSchemaSummaryByTable: Map<string, string>;
  /** Mutated by describe/sample branches; shared with grounding downstream. */
  inspectedAgentTables: Set<string>;
  requestId: number;
  requestIdRef: RefObject<number>;
  requestDataReadConsent?: () => Promise<boolean>;
  publishAgentProgress: (pending?: { action: import("./ai-workspace-types").AIWorkspaceAgentActionName; message: string }) => void;
  /** Receives the normalized checklist after each update_plan call. */
  onAgentPlanUpdate?: (plan: import("./ai-agent-context").AgentPlanStep[]) => void;
  /**
   * Runs one focused side-analysis model call for delegate (no tools, text
   * answer). The executor bounds the number of calls per run; the hook owns
   * the actual transport, timeout, and correlation.
   */
  delegateSubAnalysis?: (instruction: string, focusTables: string[]) => Promise<string>;
  getTableColumnsPreview: (connectionId: string, table: string, database?: string) => Promise<ColumnDetail[]>;
  getTableStructure: (connectionId: string, table: string, database?: string) => Promise<TableStructure>;
  getTableData: (
    connectionId: string,
    table: string,
    opts?: { database?: string; limit?: number; offset?: number },
  ) => Promise<QueryResult>;
  executeReadonlyQuery: (
    connectionId: string,
    statements: string[],
  ) => Promise<QueryResult>;
  /**
   * Read-only prepared-parameters execution (backend pins both guarantees);
   * used by run_parameterized_sql and find_value (MỚI-2/MỚI-3).
   */
  executeParameterizedReadonlyQuery: (
    connectionId: string,
    sql: string,
    parameters: Array<{ name: string; value: unknown; dataType: QueryParameterType }>,
  ) => Promise<QueryResult>;
  previewWriteTransaction: (
    connectionId: string,
    statements: string[],
  ) => Promise<{ results: Array<{ affected_rows: number; rows: unknown[][]; truncated?: boolean }> }>;
  /**
   * Creates a local database checkpoint (schema+data snapshot file). The
   * database itself is only read; safety comes from the user-facing
   * /rollback confirmation flow. Optional for tests.
   */
  createCheckpoint?: (
    label: string | null,
  ) => Promise<{ fileName: string; label: string; tableCount: number; rowCount: number }>;
  /** Lists the connection's checkpoints for restore_checkpoint. */
  listCheckpoints?: (connectionId: string) => Promise<
    Array<{ fileName: string; label: string; createdAt: number; engine: string; database: string | null; tableCount: number; rowCount: number; sizeBytes: number }>
  >;
  /** Restores a checkpoint — the picker modal keeps the human confirmation. */
  restoreCheckpoint?: (connectionId: string, fileName: string, dbType: string) => Promise<unknown>;
  /** UI language for the rollback dialog copy. */
  language?: string;
  toolAvailability?: AgentToolAvailability;
}

/**
 * Tool-dispatch layer of the agent runtime. Executes each workspace tool
 * and returns a textual observation for the model. Includes an exploration
 * de-dupe guard so identical non-read calls do not burn step budget.
 * Extracted verbatim from use-ai-slide-panel.
 */

const AGENT_PARAMETER_DATA_TYPES = new Set<string>([
  "text",
  "integer",
  "decimal",
  "boolean",
  "json",
  "null",
]);

/**
 * Infers the parameter data type from a raw JSON value, honouring an explicit
 * model-provided dataType when it is valid. Primitives bind directly; anything
 * else (objects/arrays) falls back to a JSON parameter.
 */
export function coerceAgentQueryParameter(
  name: string,
  rawValue: unknown,
  rawDataType?: unknown,
): { name: string; value: unknown; dataType: QueryParameterType } {
  let dataType: QueryParameterType = "text";
  let value = rawDataType === "null" ? null : rawValue;
  if (typeof rawDataType === "string" && AGENT_PARAMETER_DATA_TYPES.has(rawDataType)) {
    dataType = rawDataType as QueryParameterType;
    if (dataType === "null") value = null;
    if (dataType === "integer" && typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      value = Number.isFinite(parsed) ? parsed : value;
    }
    if (dataType === "decimal" && typeof value === "string") {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) value = parsed;
    }
    if (dataType === "boolean" && typeof value === "string") {
      value = value.trim().toLowerCase() === "true";
    }
  } else if (typeof value === "number") {
    dataType = Number.isInteger(value) ? "integer" : "decimal";
  } else if (typeof value === "boolean") {
    dataType = "boolean";
  } else if (value !== null && (typeof value === "object" || Array.isArray(value))) {
    dataType = "json";
  }
  return { name, value, dataType };
}

/**
 * Quotes a (possibly schema-qualified) identifier per engine dialect so
 * agent-built SQL can never break out of the identifier context.
 */
export function agentSqlQuoteIdentifier(
  dbType: DatabaseType | undefined,
  identifier: string,
): string {
  const parts = identifier.trim().split(".").filter(Boolean);
  if (parts.length === 0) return identifier;
  if (dbType === "mysql" || dbType === "mariadb") {
    return parts.map((part) => `\`${part.replace(/`/g, "``")}\``).join(".");
  }
  if (dbType === "mssql") {
    return parts.map((part) => `[${part.replace(/]/g, "]]")}]`).join(".");
  }
  return parts.map((part) => `"${part.replace(/"/g, '""')}"`).join(".");
}

/**
 * Static pre-flight shared by run_parameterized_sql and check_sql. Returns
 * the first blocking reason, or null when the SQL passes all agent guards.
 */
export function analyzeAgentSqlForAgent(
  sql: string,
  availableSchemaTables: string[],
  inspectedAgentTables: Set<string>,
): { ok: true } | { ok: false; error: string } {
  try {
    validateAIAgentReadonlySql(sql);
  } catch (errorValue) {
    return {
      ok: false,
      error: errorValue instanceof Error ? errorValue.message : String(errorValue),
    };
  }
  const catalogRefs = findSystemCatalogReferences(sql);
  if (catalogRefs.length > 0) {
    return {
      ok: false,
      error: `SQL references system catalog objects (${catalogRefs.join(", ")}). Use list_tables, search_schema, or describe_table instead of system catalogs.`,
    };
  }
  const schemaRequirements = getAgentSqlSchemaRequirements(
    sql,
    availableSchemaTables,
    inspectedAgentTables,
  );
  if (schemaRequirements.unknown.length > 0) {
    return {
      ok: false,
      error: `SQL references unknown table(s): ${schemaRequirements.unknown.join(", ")}. Use list_tables and describe_table first.`,
    };
  }
  if (schemaRequirements.uninspected.length > 0) {
    return {
      ok: false,
      error: `Inspect the schema before reading rows. Call describe_table for: ${schemaRequirements.uninspected.join(", ")}.`,
    };
  }
  return { ok: true };
}

// Matches the backend ceiling in ai_skills.rs (MAX_SKILL_BODY_CHARS = 8_000).
// The backend truncates authoritatively; this FE check is a redundant backstop
// so the two layers must not drift apart again.
const AI_SKILL_BODY_MAX_CHARS = 8_000;

export function createAgentToolExecutor(deps: AgentToolExecutorDeps) {
  const {
    connectionId,
    allowedSkillNames,
    memoryScope,
    currentDatabase,
    dbType,
    latestTables,
    availableSchemaTables,
    relationalSchemaSummaryByTable,
    inspectedAgentTables,
    requestId,
    requestIdRef,
    requestDataReadConsent,
    publishAgentProgress,
    onAgentPlanUpdate,
    delegateSubAnalysis,
    getTableColumnsPreview,
    getTableStructure,
    getTableData,
    executeReadonlyQuery,
    executeParameterizedReadonlyQuery,
    previewWriteTransaction,
    createCheckpoint,
    listCheckpoints,
    restoreCheckpoint,
    language,
    toolAvailability,
  } = deps;
  let lastExplorationToolKey = "";
  /** Side-analysis calls spent this run (delegate budget). */
  let delegateCallsUsed = 0;
  /** Local checkpoint snapshots created this run (safety budget). */
  let checkpointCallsUsed = 0;
  /** Rollback confirmations driven this run (one per run). */
  let restoreCallsUsed = 0;

  /**
   * Full (untruncated) observations from this run, 1-based-indexed in call
   * order. The trace the model sees truncates at ~1400 chars; read_page
   * re-reads the archived original at zero cost.
   */
  const observationArchive: Array<{ action: string; full: string }> = [];
  // Mutating statements successfully previewed this run (normalized). The
  // edit_query_sql gate only accepts proposals for statements the agent has
  // smoke-tested through preview_write's rollback transaction.
  const previewedMutatingStatements = new Set<string>();
  let pendingFullObservation: string | null = null;

  /** Archives the full observation and returns the truncated trace version. */
  const stringifyAgentObservation = (data: unknown) => {
    const full = stringifyAgentObservationFull(data);
    pendingFullObservation = full;
    return truncateAgentObservation(full);
  };

  const dispatchAgentTool = async (action: AIAgentToolAction): Promise<string> => {
  try {
    // Repeating an exploration call with identical arguments returns the
    // identical observation and burns a step from a tight budget. Meta actions
    // (update_plan re-posts the whole checklist by design) and delegate (which
    // has its own per-run budget) are exempt.
    const explorationKey = action.action !== "run_readonly_sql"
      && action.action !== "run_parameterized_sql"
      && action.action !== "find_value"
      && action.action !== "sample_table_data"
      && action.action !== "read_page"
      && action.action !== "update_plan"
      && action.action !== "delegate"
      && action.action !== "create_checkpoint"
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

    if (action.action === "update_plan") {
      const plan = normalizeAgentPlanSteps(action.args?.steps, AI_AGENT_PLAN_STEP_LIMIT);
      if (plan.length === 0) {
        return "Tool error: update_plan requires args.steps — a non-empty array of { title, status? } entries.";
      }
      onAgentPlanUpdate?.(plan);
      const done = plan.filter((step) => step.status === "done").length;
      const inProgress = plan.filter((step) => step.status === "in_progress").length;
      return stringifyAgentObservation({
        planUpdated: true,
        steps: plan.length,
        done,
        inProgress,
        pending: plan.length - done - inProgress,
        checklist: plan.map((step, index) => `${index + 1}. [${step.status}] ${step.title}`),
      });
    }

    if (action.action === "delegate") {
      const instruction = typeof action.args?.instruction === "string" ? action.args.instruction.trim() : "";
      if (!instruction) {
        return "Tool error: delegate requires args.instruction — a self-contained side question.";
      }
      if (!delegateSubAnalysis) {
        return "Tool notice: delegate is unavailable in this run — answer from the evidence you already have.";
      }
      if (delegateCallsUsed >= AI_AGENT_DELEGATE_MAX_CALLS) {
        return `Tool notice: delegate budget exhausted (${AI_AGENT_DELEGATE_MAX_CALLS}/${AI_AGENT_DELEGATE_MAX_CALLS} used) — continue with your own tools or finish.`;
      }
      const focusTables = Array.isArray(action.args?.focusTables)
        ? (action.args.focusTables as unknown[])
            .filter((table): table is string => typeof table === "string" && Boolean(table.trim()))
            .map((table) => table.trim())
            .slice(0, AI_AGENT_DELEGATE_FOCUS_TABLES_LIMIT)
        : [];
      delegateCallsUsed += 1;
      try {
        const answer = await delegateSubAnalysis(instruction, focusTables);
        const clean = answer.trim();
        if (!clean) {
          return "Side analysis returned nothing. Continue with your own tools.";
        }
        const bounded = clean.length > AI_AGENT_DELEGATE_ANSWER_CHARS
          ? `${clean.slice(0, AI_AGENT_DELEGATE_ANSWER_CHARS)}… [truncated]`
          : clean;
        return `Side analysis${focusTables.length > 0 ? ` (focus: ${focusTables.join(", ")})` : ""}:\n${bounded}`;
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return `Side analysis failed: ${formatExecutionError(errorValue)}. Continue with your own tools.`;
      }
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
      // Merged tool (was describe_table + describe_tables): accepts a single
      // `table` or a `tables` array (1..AI_AGENT_BATCH_DESCRIBE_LIMIT).
      const requestedTables: unknown[] = Array.isArray(action.args?.tables)
        ? action.args.tables
        : typeof action.args?.table === "string" && action.args.table.trim()
          ? [action.args.table]
          : [];
      const names = [...new Set(
        requestedTables
          .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
          .map((value) => String(value).trim())
          .filter(Boolean),
      )].slice(0, AI_AGENT_BATCH_DESCRIBE_LIMIT);
      if (names.length === 0) {
        return "Tool error: describe_table requires args.table or a non-empty args.tables array.";
      }

      if (names.length === 1) {
        const matchedTable = findMatchingTableName(names[0], availableSchemaTables);
        if (!matchedTable) {
          return `Tool error: Table "${names[0]}" is not present in the current workspace schema.`;
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
      const requestedOffset = typeof action.args?.offset === "number" && Number.isFinite(action.args.offset)
        ? Math.max(0, Math.floor(action.args.offset))
        : 0;
      // get_table_data goes through the engine driver so identifiers are
      // quoted per dialect; no model-supplied SQL is involved here.
      const queryResult = await getTableData(connectionId!, matchedTable, {
        database: currentDatabase || undefined,
        limit: requestedLimit,
        offset: requestedOffset || undefined,
      });
      if (requestId !== requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }

      inspectedAgentTables.add(matchedTable);

      // Column-statistics enrichment, GATED (audit fix: this used to run a
      // COUNT/SUM/COUNT(DISTINCT) aggregate over the WHOLE table on every
      // sample). Whole-table stats only run when the catalog rowCount is
      // known and at most AI_AGENT_COLUMN_STATS_MAX_TABLE_ROWS; anything
      // bigger — or of unknown size — computes stats from the sampled rows
      // instead, and args.stats="off" skips them entirely. Failures are
      // silent: the sample itself remains the source of truth.
      const statColumns = queryResult.columns.slice(0, 12);
      const matchedCatalogTable = latestTables.find((table) =>
        table.name === matchedTable
        || buildWorkspaceTableIdentifier(table, currentDatabase) === matchedTable
      );
      const knownRowCount = matchedCatalogTable?.row_count ?? null;
      const statsScope = resolveColumnStatsScope(
        typeof action.args?.stats === "string" ? action.args.stats : undefined,
        knownRowCount,
      );
      let columnStats: Array<{ column: string; nullRatio: number; distinctCount: number }> | undefined;
      let columnStatsScopeLabel = "";
      if (statsScope !== "off" && statColumns.length > 0 && requestedOffset === 0) {
        if (statsScope === "whole") {
          try {
            const quotedTable = agentSqlQuoteIdentifier(dbType, matchedTable);
            const selectParts = [
              "COUNT(*) AS __total",
              ...statColumns.flatMap((column, index) => {
                const quoted = agentSqlQuoteIdentifier(dbType, column.name);
                return [
                  `SUM(CASE WHEN ${quoted} IS NULL THEN 1 ELSE 0 END) AS __null_${index}`,
                  `COUNT(DISTINCT ${quoted}) AS __distinct_${index}`,
                ];
              }),
            ];
            const statsResult = await executeReadonlyQuery(connectionId!, [
              `SELECT ${selectParts.join(", ")} FROM ${quotedTable}`,
            ]);
            if (requestId !== requestIdRef.current) {
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
              .map((stat) => `${stat.column}: nullRatio=${stat.nullRatio}, distinct=${stat.distinctCount}`)
              .join(" | ")}`
          : observation,
        {
          rowsReturned: queryResult.rows.length,
          tables: [matchedTable],
          ...(columnStats ? { columnStats } : {}),
        },
      );
    }

    if (action.action === "list_schema_objects") {
      const objectType = typeof action.args?.objectType === "string" && action.args.objectType !== "all"
        ? action.args.objectType
        : undefined;
      const patternFilter = typeof action.args?.pattern === "string" ? action.args.pattern.trim().toLowerCase() : "";
      const withDefinition = action.args?.withDefinition === true;
      const limitFilter = typeof action.args?.limit === "number" && Number.isFinite(action.args.limit)
        ? Math.min(AI_AGENT_SCHEMA_OBJECTS_LIMIT, Math.max(1, Math.floor(action.args.limit)))
        : AI_AGENT_SCHEMA_OBJECTS_LIMIT;

      try {
        const objects = await invokeMutation<Array<{
          name: string;
          schema: string | null;
          object_type: string;
          related_table: string | null;
          definition: string | null;
        }>>("list_schema_objects", {
          connectionId,
          database: currentDatabase ?? null,
        });
        if (requestId !== requestIdRef.current) {
          throw new Error(AI_REQUEST_REPLACED_MESSAGE);
        }
        const filtered = objects
          .filter((object) => (objectType ? object.object_type.toLowerCase() === objectType : true))
          .filter((object) => (
            patternFilter
              ? object.name.toLowerCase().includes(patternFilter)
                || (object.related_table ?? "").toLowerCase().includes(patternFilter)
              : true
          ));
        const emit = (object: (typeof filtered)[number]) => ({
          name: object.name,
          schema: object.schema,
          objectType: object.object_type,
          relatedTable: object.related_table,
          definition: withDefinition && object.definition
            ? redactAgentSqlLiterals(
                object.definition.length > AI_AGENT_SCHEMA_OBJECT_DEFINITION_CHARS
                  ? `${object.definition.slice(0, AI_AGENT_SCHEMA_OBJECT_DEFINITION_CHARS)}\n[definition truncated]`
                  : object.definition,
              )
            : undefined,
        });
        return stringifyAgentObservation({
          objectType: objectType ?? "all",
          objectCount: filtered.length,
          truncated: filtered.length > limitFilter ? true : undefined,
          next: filtered.length > limitFilter
            ? `${filtered.length} objects exceed the ${limitFilter}-object preview. Narrow with args {"pattern":"substring"} or {"objectType":"view"}.`
            : undefined,
          objects: filtered.slice(0, limitFilter).map(emit),
          note: withDefinition
            ? undefined
            : "Set args.withDefinition=true to read the SQL definition of specific objects - it is verified business logic.",
        });
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return `Tool error: could not list schema objects: ${formatExecutionError(errorValue)}`;
      }
    }
    if (action.action === "run_preset") {
      if (toolAvailability && !toolAvailability.sqlRead) {
        return `Tool blocked: run_preset is not available on ${toolAvailability.engineLabel}. Preset SQL targets SQL engines.`;
      }
      const wantsList = action.args?.list === true || typeof action.args?.presetId !== "string";
      const presetKinds: AdminQueryKind[] = ["process-list", "user-management"];
      if (wantsList) {
        return stringifyAgentObservation({
          engine: toolAvailability?.engineLabel ?? "current engine",
          availablePresets: presetKinds.map((kind) => ({
            presetId: kind,
            ...(() => {
              const preset = getAdminQueryPreset(dbType, kind);
              return { supported: preset.supported, reason: preset.reason };
            })(),
          })),
          note: "Call again with args.presetId to run a preset. Preset SQL is pre-vetted per engine - catalog guards do not apply to it.",
        });
      }
      const presetId = action.args?.presetId === "user-management" ? "user-management" : "process-list";
      const preset = getAdminQueryPreset(dbType, presetId as AdminQueryKind);
      if (!preset.supported) {
        return `Tool blocked: the "${presetId}" preset is not available on this engine${preset.reason ? `: ${preset.reason}` : "."}`;
      }
      if (requestDataReadConsent) {
        const approved = await requestDataReadConsent();
        if (!approved) {
          return "Tool blocked: The user did not grant permission to read live database rows for this request.";
        }
      }
      try {
        const queryResult = await executeReadonlyQuery(connectionId!, [preset.content]);
        if (requestId !== requestIdRef.current) {
          throw new Error(AI_REQUEST_REPLACED_MESSAGE);
        }
        return stringifyAgentObservation({
          presetId,
          note: "Executed a pre-vetted operational preset (not model-written SQL).",
          result: summarizeAgentQueryObservation(queryResult),
        });
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return `Tool error: preset "${presetId}" failed: ${formatExecutionError(errorValue)}`;
      }
    }

    if (action.action === "read_page") {
      const total = observationArchive.length;
      if (total === 0) {
        return "Tool error: read_page has nothing to page through - no tool observations exist in this run yet.";
      }
      const requestedRef = typeof action.args?.ref === "number" && Number.isFinite(action.args.ref)
        ? Math.floor(action.args.ref)
        : total;
      if (requestedRef < 1 || requestedRef > total) {
        return `Tool error: read_page args.ref must be between 1 and ${total} (this run produced ${total} observation(s)).`;
      }
      const entry = observationArchive[requestedRef - 1];
      const offset = typeof action.args?.offset === "number" && Number.isFinite(action.args.offset)
        ? Math.max(0, Math.floor(action.args.offset))
        : 0;
      const limit = typeof action.args?.limit === "number" && Number.isFinite(action.args.limit)
        ? Math.min(AI_AGENT_READ_PAGE_MAX_CHARS, Math.max(100, Math.floor(action.args.limit)))
        : 1400;
      if (offset >= entry.full.length) {
        return stringifyAgentObservationFull({
          ref: requestedRef,
          action: entry.action,
          totalChars: entry.full.length,
          offset,
          note: "Offset is past the end of this observation. Use a smaller offset.",
        });
      }
      const slice = entry.full.slice(offset, offset + limit);
      const nextOffset = offset + slice.length;
      return stringifyAgentObservationFull({
        ref: requestedRef,
        action: entry.action,
        totalChars: entry.full.length,
        offset,
        nextOffset: nextOffset < entry.full.length ? nextOffset : undefined,
        hasMore: nextOffset < entry.full.length || undefined,
        text: slice,
      });
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
          const planText = summarizeAgentExplainPlanStructured(plan, dbType);
          if (planText) {
            explainNote = `\n\nQuery plan (EXPLAIN, not executed - structured summary with cost hotspots):\n${planText}`;
          }
        } catch (errorValue) {
          if (isSupersededAIRequestError(errorValue)) throw errorValue;
          // Engines without EXPLAIN support simply skip the cost preview.
        }
        if (requestId !== requestIdRef.current) {
          throw new Error(AI_REQUEST_REPLACED_MESSAGE);
        }
      }

      let queryResult: QueryResult;
      try {
        queryResult = await executeReadonlyQuery(connectionId!, [sql]);
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        // A timed-out query is actionable feedback, not a dead end: tell
        // the model exactly how to shrink the statement.
        return `Tool error: readonly query failed: ${formatExecutionError(errorValue)}${agentQueryTimeoutHint(errorValue)}`;
      }
      if (requestId !== requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }

      return appendAgentFacts(`${summarizeAgentQueryObservation(queryResult)}${explainNote}`, {
        rowsReturned: queryResult.rows.length,
      });
    }

    if (action.action === "run_parameterized_sql") {
      if (toolAvailability && !toolAvailability.sqlRead) {
        return agentSqlToolBlockedMessage("run_parameterized_sql", toolAvailability);
      }
      const sql = typeof action.args?.sql === "string" ? action.args.sql.trim() : "";
      if (!sql) {
        return "Tool error: run_parameterized_sql requires args.sql.";
      }
      const rawParameters = Array.isArray(action.args?.parameters) ? action.args.parameters : [];
      const parameters: Array<{ name: string; value: unknown; dataType: QueryParameterType }> = [];
      for (const item of rawParameters) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name.trim() : "";
        if (!name || !("value" in record)) {
          return 'Tool error: every parameters[] entry requires a non-empty "name" and a "value".';
        }
        parameters.push(coerceAgentQueryParameter(name, record.value, record.dataType));
      }
      if (parameters.length === 0) {
        return 'Tool error: run_parameterized_sql requires bindings like [{"name":"status","value":"active"}]. Reference them in SQL as :name.';
      }

      const guard = analyzeAgentSqlForAgent(sql, availableSchemaTables, inspectedAgentTables);
      if (!guard.ok) {
        return `Tool blocked: ${guard.error}`;
      }

      if (requestDataReadConsent) {
        const approved = await requestDataReadConsent();
        if (!approved) {
          return "Tool blocked: The user did not grant permission to read live database rows for this request.";
        }
      }

      try {
        const queryResult = await executeParameterizedReadonlyQuery(connectionId!, sql, parameters);
        if (requestId !== requestIdRef.current) {
          throw new Error(AI_REQUEST_REPLACED_MESSAGE);
        }
        return appendAgentFacts(stringifyAgentObservation({
          parameterized: true,
          parameterCount: parameters.length,
          result: summarizeAgentQueryObservation(queryResult),
        }), {
          rowsReturned: queryResult.rows.length,
        });
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return `Tool error: parameterized query failed: ${formatExecutionError(errorValue)}${agentQueryTimeoutHint(errorValue)}`;
      }
    }

    if (action.action === "find_value") {
      if (toolAvailability && !toolAvailability.sqlRead) {
        return agentSqlToolBlockedMessage("find_value", toolAvailability);
      }
      const requestedTable = typeof action.args?.table === "string" ? action.args.table.trim() : "";
      const requestedColumn = typeof action.args?.column === "string" ? action.args.column.trim() : "";
      if (!requestedTable || !requestedColumn) {
        return "Tool error: find_value requires args.table and args.column.";
      }
      if (!("value" in (action.args ?? {}))) {
        return "Tool error: find_value requires args.value.";
      }

      const matchedTable = findMatchingTableName(requestedTable, availableSchemaTables);
      if (!matchedTable) {
        return `Tool error: Table "${requestedTable}" is not present in the current workspace schema.`;
      }

      // Verify the column against the real structure so a hallucinated column
      // name fails here with the actual list instead of at the driver.
      const columns = await getTableColumnsPreview(connectionId!, matchedTable, currentDatabase || undefined);
      if (requestId !== requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }
      const matchedColumn = columns.find(
        (column) => column.name.toLowerCase() === requestedColumn.toLowerCase(),
      );
      if (!matchedColumn) {
        return `Tool error: Column "${requestedColumn}" does not exist on ${matchedTable}. Available columns: ${columns.map((column) => column.name).join(", ")}.`;
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
      const quotedTable = agentSqlQuoteIdentifier(dbType, matchedTable);
      const quotedColumn = agentSqlQuoteIdentifier(dbType, matchedColumn.name);
      const binding = coerceAgentQueryParameter("value", action.args.value);
      const sql = dbType === "mssql"
        ? `SELECT TOP (${requestedLimit}) * FROM ${quotedTable} WHERE ${quotedColumn} = :value`
        : `SELECT * FROM ${quotedTable} WHERE ${quotedColumn} = :value LIMIT ${requestedLimit}`;

      try {
        const queryResult = await executeParameterizedReadonlyQuery(connectionId!, sql, [binding]);
        if (requestId !== requestIdRef.current) {
          throw new Error(AI_REQUEST_REPLACED_MESSAGE);
        }
        inspectedAgentTables.add(matchedTable);
        return stringifyAgentObservation({
          table: matchedTable,
          column: matchedColumn.name,
          value: binding.value,
          parameterized: true,
          result: summarizeAgentQueryObservation(queryResult),
        });
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return `Tool error: find_value failed: ${formatExecutionError(errorValue)}${agentQueryTimeoutHint(errorValue)}`;
      }
    }

    if (action.action === "check_sql") {
      if (toolAvailability && !toolAvailability.sqlRead) {
        return agentSqlToolBlockedMessage("check_sql", toolAvailability);
      }
      const sql = typeof action.args?.sql === "string" ? action.args.sql.trim() : "";
      if (!sql) {
        return "Tool error: check_sql requires args.sql.";
      }
      const analysis = analyzeAgentSqlForAgent(sql, availableSchemaTables, inspectedAgentTables);
      const unboundedSelect = analysis.ok
        && /^(SELECT|WITH)\b/i.test(sql)
        && !/\bLIMIT\s+\d/i.test(sql)
        && !/^EXPLAIN\b/i.test(sql);
      return stringifyAgentObservation({
        ok: analysis.ok && !unboundedSelect,
        sql: redactAgentSqlLiterals(sql),
        issues: analysis.ok ? [] : [analysis.error],
        ...(unboundedSelect
          ? { notes: ["The SELECT has no LIMIT - add one before finishing so it can never become a full-table pull."] }
          : {}),
        note: analysis.ok && !unboundedSelect
          ? "Pre-flight passed. You may now finish with this SQL."
          : "Fix every issue (or re-check corrected SQL) before calling finish.",
      });
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
        for (const statement of statements) {
          if (isMutatingStatement(statement) || isHighRiskStatement(statement)) {
            previewedMutatingStatements.add(normalizeStatementForGuard(statement));
          }
        }
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

    if (action.action === "create_checkpoint") {
      if (checkpointCallsUsed >= 3) {
        return "Tool error: create_checkpoint budget exhausted for this run (3 snapshots max). The user can always create one manually with /backup.";
      }
      checkpointCallsUsed += 1;
      if (typeof createCheckpoint !== "function") {
        return "Tool error: create_checkpoint is unavailable in this context.";
      }
      const label = typeof action.args?.label === "string" ? action.args.label.trim() : "";
      try {
        const result = await createCheckpoint(label || null);
        return `Checkpoint created: ${result.tableCount} tables, ${result.rowCount} rows saved locally (label: "${result.label}"). The user can restore it with the /rollback command — suggest that command if an upcoming or just-executed change looks wrong.`;
      } catch (errorValue) {
        return `Tool error: create_checkpoint failed. ${
          errorValue instanceof Error ? errorValue.message : String(errorValue)
        }`;
      }
    }

    if (action.action === "restore_checkpoint") {
      if (restoreCallsUsed >= 1) {
        return "Tool error: restore_checkpoint budget exhausted for this run (1 rollback max). The user can always run /rollback manually.";
      }
      restoreCallsUsed += 1;
      if (
        !connectionId
        || !dbType
        || typeof listCheckpoints !== "function"
        || typeof restoreCheckpoint !== "function"
      ) {
        return "Tool error: restore_checkpoint is unavailable in this context.";
      }
      const hint = typeof action.args?.label_hint === "string" ? action.args.label_hint.trim().toLowerCase() : "";
      const checkpoints = await listCheckpoints(connectionId);
      if (!checkpoints.length) {
        return "No checkpoints exist for this connection. The user can create one with /backup or your create_checkpoint tool.";
      }
      const chosen = hint
        ? checkpoints.find((entry) => entry.label.toLowerCase().includes(hint)) ?? checkpoints[0]
        : checkpoints[0];
      // Human confirmation is mandatory: the picker modal opens directly on
      // this checkpoint; the run resumes only after Restore/Cancel.
      publishAgentProgress({
        action: "restore_checkpoint",
        message: `Rollback to "${chosen.label}" — waiting for the user to confirm.`,
      });
      const fileName = await requestAICheckpointPick(
        [chosen],
        language || "en",
        connectionId,
        dbType,
      );
      if (!fileName) {
        return "User cancelled the rollback. No changes were made.";
      }
      try {
        await restoreCheckpoint(connectionId, fileName, dbType);
        return `Database restored to checkpoint "${chosen.label}". Remind the user to reopen tables if a stale view remains, and continue follow-up work on the restored data.`;
      } catch (errorValue) {
        return `Tool error: rollback failed. ${
          errorValue instanceof Error ? errorValue.message : String(errorValue)
        }`;
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
      // Fail-closed: only names injected in this run's catalog may load.
      if (!allowedSkillNames?.includes(skillName)) {
        return `Tool error: skill "${skillName}" is not in the injected <available_skills> catalog. Pick one of the listed skills.`;
      }
      try {
        const content = await invokeMutation<{ name: string; body: string }>("read_ai_skill", {
          name: skillName,
        });
        window.dispatchEvent(new CustomEvent("workspace-activity", {
          detail: { connectionId, label: `Skill: ${content.name}`, durationMs: 0 },
        }));
        useSkillUsageStore.getState().recordSkillRun(content.name || skillName, connectionId);
        // Soft cost ceiling: a huge skill file would otherwise be re-injected
        // into the prompt on every remaining run step.
        const rawBody = content.body ?? "";
        const body =
          rawBody.length > AI_SKILL_BODY_MAX_CHARS
            ? `${rawBody.slice(0, AI_SKILL_BODY_MAX_CHARS)}\n\n[Body cut at ${AI_SKILL_BODY_MAX_CHARS} characters — the skill file is larger. Follow the instructions above; ask the user to trim the skill if a needed section is missing.]`
            : rawBody;
        return [
          `Skill "${content.name}" loaded. Follow these instructions for the remainder of the run:`,
          "",
          body,
        ].join("\n");
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return `Tool error: could not load skill "${skillName}": ${formatExecutionError(errorValue)}`;
      }
    }

    if (action.action === "edit_query_sql") {
      const rawTabId = typeof action.args?.tabId === "string" ? action.args.tabId.trim() : "";
      const sql = typeof action.args?.sql === "string" ? action.args.sql.trim() : "";
      const reason = typeof action.args?.reason === "string" ? action.args.reason.trim() : "";
      if (!rawTabId || !sql) {
        return "Tool error: edit_query_sql requires args.tabId and args.sql from the Query tabs list.";
      }
      if (sql.includes("…[TRUNCATED")) {
        return "Tool error: do not echo the truncation marker from the context. Propose only content you have actually seen; explain anything outside your view in args.reason.";
      }
      // The tab must exist, be a query tab, and belong to THIS run's
      // connection — the agent must not reach into another connection's
      // editors.
      const { tabs } = useUIStore.getState();
      const target = tabs.find((tab) => tab.id === rawTabId);
      if (!target || target.type !== "query") {
        return "Tool error: edit_query_sql needs the exact tabId of an open query tab (see the Query tabs list in the context).";
      }
      if (target.connectionId !== connectionId) {
        return `Tool error: query tab "${target.title}" belongs to another connection — edit_query_sql cannot reach across connections.`;
      }
      // Smoke-test gate: a mutating proposal that was never previewed in
      // THIS run is rejected. Reads go through the sandbox naturally.
      const mutating = isMutatingStatement(sql) || isHighRiskStatement(sql);
      if (mutating && !previewedMutatingStatements.has(normalizeStatementForGuard(sql))) {
        return "Tool error: this proposal contains mutating SQL that was not previewed in this run. Call preview_write with the exact statement first, then re-issue edit_query_sql.";
      }
      const reasonLine = reason || "Corrected SQL proposal from the agent.";
      // Proposal only: the tab renders Accept/Reject. The agent never
      // writes editor content directly and never executes the proposal.
      EventCenter.emit("ai-edit-query-sql", { tabId: rawTabId, sql, reason: reasonLine });
      return [
        `Proposal sent to query tab "${target.title}" — waiting for the user to accept or reject it in the tab.`,
        `Fix: ${reasonLine}`,
        mutating
          ? "Reminder: on accept the tab content changes only; the user still runs it (an auto-checkpoint is captured first)."
          : "On accept the tab content changes only; the user still runs it.",
      ].join("\n");
    }

    if (action.action === "read_memory") {
      const memoryName = typeof action.args?.name === "string" ? action.args.name.trim() : "";
      if (!memoryName) {
        return "Tool error: read_memory requires args.name taken from the <agent_memory> index.";
      }
      try {
        const content = await invokeMutation<{ name: string; body: string; updatedAt?: string }>(
          "read_agent_memory",
          {
            name: memoryName,
            connectionId: memoryScope?.connectionId ?? null,
            database: memoryScope?.database ?? null,
          },
        );
        window.dispatchEvent(new CustomEvent("workspace-activity", {
          detail: { connectionId, label: `Memory: ${content.name}`, durationMs: 0 },
        }));
        const updatedNote = content.updatedAt ? ` (last updated ${content.updatedAt})` : "";
        return [
          `Memory "${content.name}" loaded${updatedNote}. Treat it as a saved observation, not a live fact — re-verify anything the schema contradicts:`,
          "",
          content.body ?? "",
        ].join("\n");
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return `Tool error: could not load memory "${memoryName}": ${formatExecutionError(errorValue)}`;
      }
    }

    if (action.action === "save_memory") {
      const memoryName = typeof action.args?.name === "string" ? action.args.name.trim() : "";
      const memoryBody = typeof action.args?.body === "string" ? action.args.body.trim() : "";
      const memoryDescription = typeof action.args?.description === "string" ? action.args.description.trim() : "";
      if (!memoryName || !memoryBody) {
        return "Tool error: save_memory requires non-empty args.name (short slug) and args.body (the fact worth remembering).";
      }
      try {
        const saved = await invokeMutation<{ name: string; updatedAt: string }>("save_agent_memory", {
          name: memoryName,
          body: memoryBody,
          description: memoryDescription || null,
          connectionId: memoryScope?.connectionId ?? null,
          database: memoryScope?.database ?? null,
        });
        window.dispatchEvent(new CustomEvent("workspace-activity", {
          detail: { connectionId, label: `Memory saved: ${saved.name}`, durationMs: 0 },
        }));
        return `Memory "${saved.name}" saved for this connection/database scope${saved.updatedAt ? ` at ${saved.updatedAt}` : ""}. Future runs in this scope will see it in their <agent_memory> index. Never store credentials in memory.`;
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        return `Tool error: could not save memory "${memoryName}": ${formatExecutionError(errorValue)}`;
      }
    }

    // Unknown action: never say "finish" here — the model needs the list of
    // valid tools to self-correct (a bare "unknown tool" makes small models
    // conclude the deployment is broken instead of retrying).
    if (action.action === "finish") {
      return "Tool error: finish does not execute a tool observation.";
    }
    const availableTools = AI_AGENT_TOOL_NAMES
      .filter((toolName) => toolName !== "finish")
      .join(", ");
    return `Tool error: unknown tool "${action.action}". Available tools: ${availableTools}. Choose one of these, or return a finish action with args.response if the task is complete.`;
  } catch (errorValue) {
    if (isSupersededAIRequestError(errorValue)) {
      throw errorValue;
    }
    return `Tool error: ${formatExecutionError(errorValue)}`;
  }
};

  const runAgentTool = async (action: AIAgentToolAction): Promise<string> => {
    pendingFullObservation = null;
    const result = await dispatchAgentTool(action);
    observationArchive.push({
      action: action.action,
      full: pendingFullObservation ?? result,
    });
    return result;
  };

  return { runAgentTool };
}
