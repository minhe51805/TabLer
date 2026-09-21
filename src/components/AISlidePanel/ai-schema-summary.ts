import type { TableInfo, TableStructure } from "../../types/database";
import {
  AI_SCHEMA_CODEC_VERSION,
  encodeStructureForAI,
  pickRelevantTables,
} from "./AISlidePanelUtils";
import { AI_SCHEMA_CODEC_LEGEND, buildWorkspaceTableIdentifier } from "./ai-agent-context";
import { mapWithConcurrency } from "./ai-async-utils";
import type { AIWorkspaceAgentActionName } from "./ai-workspace-types";

/**
 * Auto-injected schema summary.
 *
 * The agent used to start every run blind: it saw table NAMES in the context
 * and had to burn search_schema/describe_table round-trips before it could
 * write one grounded query. This module builds a compact whole-catalog summary
 * (tables + columns + PK/FK via the relational schema codec) once per
 * connection+database, caches it for a short TTL, and lets the context loader
 * prepend it to the assembled context so the first controller call already
 * sees real columns. search_schema stays available for detail the cap trimmed.
 */

/** ~2k tokens at a conservative 4 chars/token. */
export const AGENT_SCHEMA_SUMMARY_CHAR_BUDGET = 8_000;
/** Freshness window; schema-affecting tool calls invalidate earlier. */
export const AGENT_SCHEMA_SUMMARY_TTL_MS = 300_000;
/** Structures fetched per build; the rest of the catalog degrades to names. */
const MAX_SCHEMA_SUMMARY_DETAIL_TABLES = 24;
/** Bound on concurrent get_table_structure calls during one build. */
const SCHEMA_SUMMARY_FETCH_CONCURRENCY = 4;
/** Bound on cached scopes (connection+database pairs). */
const MAX_SCHEMA_SUMMARY_CACHE_ENTRIES = 32;
/** Names listed in the names-only fallback before the count takes over. */
const MAX_SCHEMA_SUMMARY_NAME_ENTRIES = 400;

interface SchemaSummaryCacheEntry {
  at: number;
  summary: string;
}

const schemaSummaryCache = new Map<string, SchemaSummaryCacheEntry>();
/** In-flight builds dedupe concurrent runs on the same scope. */
const schemaSummaryInFlight = new Map<string, Promise<string | null>>();

/**
 * Drops the cached summary for one connection (every database scope) — or all
 * connections when no id is given. Called after tool calls that can change the
 * schema so the next run never serves a pre-change summary inside the TTL.
 */
export function invalidateAgentSchemaSummary(connectionId?: string) {
  if (!connectionId) {
    schemaSummaryCache.clear();
    return;
  }
  const prefix = `${connectionId}:`;
  for (const key of [...schemaSummaryCache.keys()]) {
    if (key.startsWith(prefix)) schemaSummaryCache.delete(key);
  }
}

/**
 * The agent surface has no direct execute_write/create_table tool: persistent
 * schema change reaches the database through user-applied proposals
 * (edit_query_sql, propose_seed_data), checkpoint restores, or a previewed
 * statement the user then runs. Those calls invalidate the summary cache —
 * cheap insurance since the TTL already bounds staleness.
 */
const SCHEMA_AFFECTING_AGENT_ACTIONS: Record<string, true> = {
  preview_write: true,
  edit_query_sql: true,
  propose_seed_data: true,
  restore_checkpoint: true,
};

export function isSchemaAffectingAgentAction(action: AIWorkspaceAgentActionName): boolean {
  return SCHEMA_AFFECTING_AGENT_ACTIONS[action] === true;
}

export interface AgentSchemaSummaryOptions {
  connectionId: string | null;
  currentDatabase: string | null;
  /** Lowercased user prompt — ranks detail lines toward the asked-about tables. */
  normalizedPrompt: string;
  tables: TableInfo[];
  getTableStructure: (
    connectionId: string,
    table: string,
    database?: string,
  ) => Promise<TableStructure>;
  /** Output cap in characters (~4 chars/token); defaults to the 2k-token budget. */
  charBudget?: number;
}

/**
 * Returns the summary block to prepend to the assembled context, or null when
 * there is nothing to say (no connection, empty catalog, fetch failure). Never
 * throws and never rejects: a summary must not be able to break a run.
 */
export async function getAgentSchemaSummary(
  options: AgentSchemaSummaryOptions,
): Promise<string | null> {
  const { connectionId, currentDatabase, tables } = options;
  if (!connectionId || tables.length === 0) return null;

  const scopeKey = `${connectionId}:${currentDatabase || "default"}`;
  const cached = schemaSummaryCache.get(scopeKey);
  if (cached && Date.now() - cached.at < AGENT_SCHEMA_SUMMARY_TTL_MS) {
    return cached.summary;
  }

  const inFlight = schemaSummaryInFlight.get(scopeKey);
  if (inFlight) return inFlight;

  const build = buildAgentSchemaSummary(options)
    .then((summary) => {
      if (summary) {
        if (schemaSummaryCache.size >= MAX_SCHEMA_SUMMARY_CACHE_ENTRIES) {
          const oldestKey = schemaSummaryCache.keys().next().value;
          if (oldestKey) schemaSummaryCache.delete(oldestKey);
        }
        schemaSummaryCache.set(scopeKey, { at: Date.now(), summary });
      }
      return summary;
    })
    .catch(() => null)
    .finally(() => {
      schemaSummaryInFlight.delete(scopeKey);
    });
  schemaSummaryInFlight.set(scopeKey, build);
  return build;
}

async function buildAgentSchemaSummary(options: AgentSchemaSummaryOptions): Promise<string | null> {
  const { connectionId, currentDatabase, normalizedPrompt, tables, getTableStructure } = options;
  const charBudget = options.charBudget ?? AGENT_SCHEMA_SUMMARY_CHAR_BUDGET;

  // Relevance-first ordering: pickRelevantTables returns the best prompt
  // matches (capped), the rest of the catalog follows in store order.
  const prioritized = pickRelevantTables(normalizedPrompt, tables);
  const prioritizedSet = new Set(prioritized);
  const ordered = [...prioritized, ...tables.filter((table) => !prioritizedSet.has(table))];
  const allNames = ordered
    .map((table) => buildWorkspaceTableIdentifier(table, currentDatabase) || table.name)
    .filter(Boolean);
  if (allNames.length === 0) return null;

  const header = [
    "Workspace schema summary (auto-injected, verified at run start):",
    `DB=${currentDatabase || "Default"}`,
    `SCHEMA=${AI_SCHEMA_CODEC_VERSION}|mode=relational|rowdata=0`,
    AI_SCHEMA_CODEC_LEGEND,
  ].join("\n");

  const detailTables = ordered.slice(0, MAX_SCHEMA_SUMMARY_DETAIL_TABLES);
  const detailLines = await mapWithConcurrency(
    detailTables,
    SCHEMA_SUMMARY_FETCH_CONCURRENCY,
    async (table) => {
      const tableName = buildWorkspaceTableIdentifier(table, currentDatabase) || table.name;
      try {
        const structure = await getTableStructure(
          connectionId!,
          tableName,
          currentDatabase || undefined,
        );
        return encodeStructureForAI(tableName, structure, { mode: "relational" });
      } catch {
        // A table that refuses introspection still exists — keep a stub line
        // so the agent knows the name is real but must describe it live.
        return `T:${tableName}|C:[]`;
      }
    },
  );

  // Greedy fill: detail lines until the budget runs out, then a names tail.
  const lines: string[] = [];
  let used = header.length;
  for (const line of detailLines) {
    if (used + line.length + 1 > charBudget) break;
    lines.push(line);
    used += line.length + 1;
  }

  if (lines.length === 0) {
    // Even one detail line overflows the cap — fall back to a names-only
    // catalog plus a note, per the summary contract.
    const names = allNames.slice(0, MAX_SCHEMA_SUMMARY_NAME_ENTRIES);
    const namesLine = `TABLES(${allNames.length}): ${names.join(", ")}${
      allNames.length > names.length ? ", ..." : ""
    }`;
    return [
      header,
      namesLine.length > charBudget ? `${namesLine.slice(0, charBudget)}…` : namesLine,
      "NOTE=Schema too large for an inline summary — table names only. Use list_tables, search_schema and describe_table for columns, keys and indexes.",
    ].join("\n");
  }

  const undetailed = allNames.slice(lines.length);
  if (undetailed.length > 0) {
    const tailPrefix = `… ${undetailed.length} more tables: `;
    const tailBudget = charBudget - used - 1;
    if (tailBudget >= tailPrefix.length) {
      let tailNames = "";
      for (const name of undetailed) {
        const candidate = tailNames ? `${tailNames}, ${name}` : name;
        if (tailPrefix.length + candidate.length > tailBudget) break;
        tailNames = candidate;
      }
      lines.push(tailNames ? `${tailPrefix}${tailNames}` : `… ${undetailed.length} more tables`);
    }
  }

  return [...[header], ...lines].join("\n");
}
