import type { RefObject } from "react";
import type {
  ColumnDetail,
  DatabaseType,
  QueryParameterType,
  QueryResult,
  TableInfo,
  TableStructure,
} from "../../types";
import { canonicalizeAgentArgs, type AgentPlanStep } from "./ai-agent-context";
import { formatExecutionError } from "../SQLEditor/SQLEditorUtils";
import { truncateAgentObservation } from "./ai-agent-grounding";
import { type AgentToolAvailability } from "./ai-agent-engine-gates";
import { isUnattendedAllowedTool, unattendedToolBlockReason } from "./ai-agent-unattended";
import {
  AI_AGENT_BATCH_CALL_LIMIT,
  type AIAgentToolAction,
  type AIAgentBatchArgs,
  type AIAgentBatchCall,
  type AIAgentToolName,
  AI_AGENT_TOOL_NAMES,
} from "./ai-agent-tools";
import { invalidateAgentSchemaSummary, isSchemaAffectingAgentAction } from "./ai-schema-summary";
import { type AgentRuleVerdict } from "./ai-agent-rules";
import type { AIWorkspaceAgentActionName, AIWorkspaceRunTraceEntry } from "./ai-workspace-types";
import { isSupersededAIRequestError } from "./ai-agent-action-requestor";
import {
  agentSqlErrorHint,
  agentToolError,
  isRetryableAgentToolError,
  suggestAgentTableNames,
} from "./agent-tool-executor-helpers";
import { AGENT_TOOL_HANDLERS } from "./agent-tools";
import {
  SKILL_RESTRICTION_ESSENTIAL_TOOLS,
  type AgentToolCallFrame,
  type AgentToolContext,
} from "./agent-tools/shared";

// Back-compat: these pure helpers were public on this module before the split
// (and are covered by the golden-set eval), so keep re-exporting them here.
export {
  analyzeAgentSqlForAgent,
  agentSqlQuoteIdentifier,
  coerceAgentQueryParameter,
  computeSampleColumnStats,
  normalizeAgentPlanSteps,
  resolveColumnStatsScope,
} from "./agent-tool-executor-helpers";
export type { AgentColumnStatsScope } from "./agent-tool-executor-helpers";

export interface AgentToolExecutorDeps {
  connectionId: string | null;
  /**
   * P10 unattended read-only policy for scheduled agent tasks. When true the
   * executor refuses every tool outside the read-only allow-list (fail-closed),
   * independently of the catalog filter that already removed them from the
   * request. Attended runs leave this false and keep the full tool surface.
   */
  unattendedReadOnly?: boolean;
  /** Names injected in this run's <available_skills> catalog. When set, the
   * skill tool refuses anything outside the list so "injected == loadable"
   * stays true even if the catalog is later filtered or capped. */
  allowedSkillNames?: string[];
  /** Scope for the agent-memory store (read_memory/save_memory tools). Memory
   * is keyed by connection+database — the same scope as the glossary — so a
   * different connection or database can never see another's memories. */
  memoryScope?: { connectionId: string | null; database: string | null };
  /** Opens a NEW AI Query tab for the edit_query_sql createIfMissing path.
   *  Read-only proposals auto-run; mutating ones wait for the user. */
  openQueryTab?: (args: { sql: string; title: string; autoRun: boolean }) => boolean;
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
  /** Per-call destructive-action confirmation. Always shows a dialog and is
   * never backed by a standing grant — required for irreversible tools such
   * as delete_memory (fail-closed when absent). */
  requestDataDestructiveConsent?: (detail: {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<boolean>;
  publishAgentProgress: (pending?: { action: AIWorkspaceAgentActionName; message: string }) => void;
  /** Receives the normalized checklist after each update_plan call. */
  onAgentPlanUpdate?: (plan: AgentPlanStep[]) => void;
  /**
   * Runs one focused side-analysis model call for delegate (no tools, text
   * answer). The executor bounds the number of calls per run; the hook owns
   * the actual transport, timeout, and correlation.
   */
  delegateSubAnalysis?: (instruction: string, focusTables: string[]) => Promise<string>;
  getTableColumnsPreview: (
    connectionId: string,
    table: string,
    database?: string,
  ) => Promise<ColumnDetail[]>;
  getTableStructure: (
    connectionId: string,
    table: string,
    database?: string,
  ) => Promise<TableStructure>;
  getTableData: (
    connectionId: string,
    table: string,
    opts?: { database?: string; limit?: number; offset?: number },
  ) => Promise<QueryResult>;
  executeReadonlyQuery: (connectionId: string, statements: string[]) => Promise<QueryResult>;
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
  ) => Promise<{
    results: Array<{ affected_rows: number; rows: unknown[][]; truncated?: boolean }>;
  }>;
  /**
   * Non-executing EXPLAIN dry-run for mutating edit_query_sql proposals
   * (backend `explain_agent_statement`). Optional so pure executor tests need
   * no Tauri runtime; when absent the proposal ships without a plan line.
   */
  explainStatement?: (connectionId: string, sql: string) => Promise<QueryResult>;
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
    Array<{
      fileName: string;
      label: string;
      createdAt: number;
      engine: string;
      database: string | null;
      tableCount: number;
      rowCount: number;
      sizeBytes: number;
    }>
  >;
  /** Restores a checkpoint — the picker modal keeps the human confirmation. */
  restoreCheckpoint?: (connectionId: string, fileName: string, dbType: string) => Promise<unknown>;
  /** UI language for the rollback dialog copy. */
  language?: string;
  toolAvailability?: AgentToolAvailability;
  /**
   * Evaluates candidate statements against the armed guardrail rule pack
   * (`agent_rules.rs`). Returns the *folded* run verdict.
   *
   * Optional on purpose: the pure executor tests must not need a Tauri runtime,
   * and an absent hook leaves the write path on the legacy rails exactly as
   * before. When present, a `block` rule refuses the preview and its reason is
   * fed back to the model as the tool result.
   */
  evaluateGuardrailRules?: (
    statements: string[],
    options: { isMutating: boolean; workspaceDir?: string | null },
  ) => Promise<AgentRuleVerdict>;
}

/**
 * Tool-dispatch layer of the agent runtime. Owns the run-level guards (skill
 * restriction, unattended read-only, exploration de-dupe, per-run result
 * cache, pre-write checkpoint, audit trace) and the batch scheduler; the
 * per-tool behavior lives in agent-tools/ behind the AGENT_TOOL_HANDLERS
 * registry. Returns a textual observation for the model.
 */

/** One-line "key=value" args summary for the run-details audit trail. SQL
 *  bodies are skipped here — they render in the entry's own SQL block. */
function summarizeToolCallArgs(action: AIAgentToolAction): string {
  const args = action.args;
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (key === "sql" || key === "statements") continue;
    if (value === undefined || value === null) continue;
    let text: string;
    if (typeof value === "string") {
      text = value.replace(/\s+/g, " ").trim();
    } else {
      try {
        text = JSON.stringify(value);
      } catch {
        continue;
      }
    }
    if (!text) continue;
    if (text.length > 48) text = `${text.slice(0, 45)}…`;
    parts.push(`${key}=${text}`);
    if (parts.join(", ").length > 160) break;
  }
  const summary = parts.join(", ");
  return summary.length > 180 ? `${summary.slice(0, 177)}…` : summary;
}

/** SQL a tool call carried in its args: a single `sql` string or the
 *  `statements` array preview_write submits. */
function extractToolCallSql(action: AIAgentToolAction): string | null {
  const args = action.args as Record<string, unknown> | undefined;
  if (!args || typeof args !== "object") return null;
  if (typeof args.sql === "string" && args.sql.trim()) return args.sql.trim();
  if (Array.isArray(args.statements)) {
    const statements = args.statements
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .map((value) => value.trim());
    if (statements.length > 0) return statements.join("\n");
  }
  return null;
}

/**
 * Per-run result cache for deterministic read tools: an identical
 * (tool, canonical args) call returns the archived observation instead of
 * burning a backend round-trip and a step. Only read tools are cached —
 * anything that can change state (or prompt the user) always re-runs.
 */
const CACHEABLE_AGENT_TOOLS: Record<string, true> = {
  list_tables: true,
  search_schema: true,
  list_schema_objects: true,
  describe_table: true,
  describe_tables: true,
  run_readonly_sql: true,
  run_parameterized_sql: true,
  find_value: true,
  check_sql: true,
  run_preset: true,
  read_memory: true,
  read_skill_resource: true,
};
/** Calls whose success can make cached reads stale (schema or memory writes). */
const CACHE_INVALIDATING_AGENT_TOOLS: Record<string, true> = {
  preview_write: true,
  edit_query_sql: true,
  propose_seed_data: true,
  restore_checkpoint: true,
  save_memory: true,
  delete_memory: true,
};

/**
 * Tools a batch may run concurrently: pure reads with no user prompt and no
 * run-state mutation. Consent-gated reads (sample_table_data, find_value)
 * stay serial — two parallel consent dialogs would race.
 */
const BATCH_PARALLEL_TOOLS: Record<string, true> = {
  list_tables: true,
  search_schema: true,
  list_schema_objects: true,
  describe_table: true,
  describe_tables: true,
  run_readonly_sql: true,
  run_parameterized_sql: true,
  check_sql: true,
  run_preset: true,
  read_memory: true,
  read_skill_resource: true,
};
/** Tools that can never ride a batch: loop mechanics and user-facing turns. */
const BATCH_FORBIDDEN_TOOLS: Record<string, true> = {
  batch: true,
  finish: true,
  ask_user: true,
  update_plan: true,
  delegate: true,
  skill: true,
  read_page: true,
};

export function createAgentToolExecutor(deps: AgentToolExecutorDeps) {
  const {
    connectionId,
    availableSchemaTables,
    createCheckpoint,
    unattendedReadOnly = false,
  } = deps;
  let lastExplorationToolKey = "";
  /**
   * P10: tools the model attempted but the unattended read-only policy refused.
   * Reported back with the run outcome so a scheduled task is never claimed to
   * have done something it was blocked from doing.
   */
  const unattendedBlockedToolsUsed = new Set<AIAgentToolName>();
  /** Audit trail: one entry per dispatched tool call, in call order. */
  const runTrace: AIWorkspaceRunTraceEntry[] = [];

  const toolResultCache = new Map<string, { trace: string; full: string }>();
  const agentToolCacheKey = (action: AIAgentToolAction) =>
    CACHEABLE_AGENT_TOOLS[action.action] === true
      ? `${action.action}:${canonicalizeAgentArgs(action.args ?? {})}`
      : null;

  /** "Did you mean" hint for a table name that matched nothing in the schema. */
  const tableNotFoundHint = (requested: string): string | undefined => {
    const suggestions = suggestAgentTableNames(requested, availableSchemaTables);
    return suggestions.length > 0
      ? `Did you mean: ${suggestions.join(", ")}? Re-run with an exact name from list_tables.`
      : "Call list_tables (optionally with args.pattern) to see the exact table names, then retry.";
  };

  /**
   * Best-effort pre-write checkpoint: the first mutating preview_write /
   * edit_query_sql of a run snapshots the database under the "agent-pre-write"
   * label so a bad proposal is one /rollback away from undone. Runs once per
   * run; a failure warns inside the tool observation but never blocks.
   */
  let preWriteCheckpoint: { attempted: boolean; note: string } = {
    attempted: false,
    note: "",
  };
  const ensurePreWriteCheckpoint = async (): Promise<string> => {
    if (preWriteCheckpoint.attempted) return preWriteCheckpoint.note;
    preWriteCheckpoint.attempted = true;
    if (typeof createCheckpoint !== "function" || !connectionId) {
      preWriteCheckpoint.note =
        "Pre-write checkpoint unavailable in this context — proceeding without a snapshot.";
      return preWriteCheckpoint.note;
    }
    try {
      const result = await createCheckpoint("agent-pre-write");
      preWriteCheckpoint.note = `Pre-write checkpoint saved (${result.tableCount} tables, ${result.rowCount} rows, label "agent-pre-write") — restorable via /rollback.`;
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      preWriteCheckpoint.note = `Pre-write checkpoint failed (${formatExecutionError(errorValue)}) — proceeding without a snapshot.`;
    }
    return preWriteCheckpoint.note;
  };

  /**
   * Shared deps + mutable run state handed to every tool handler. Handlers
   * mutate the budget counters, skill state, previewed-statement set, and
   * observation archive in place; the guards below read the same object.
   */
  const ctx: AgentToolContext = {
    ...deps,
    delegateCallsUsed: 0,
    checkpointCallsUsed: 0,
    restoreCallsUsed: 0,
    loadedSkillResources: new Map<string, Set<string>>(),
    skillToolRestriction: null,
    previewedMutatingStatements: new Set<string>(),
    observationArchive: [],
    ensurePreWriteCheckpoint,
    tableNotFoundHint,
  };

  const dispatchAgentTool = async (
    action: AIAgentToolAction,
    frame: AgentToolCallFrame,
  ): Promise<string> => {
    try {
      // allowed-tools guardrail: a loaded skill may confine the run to a declared
      // tool set. Essential meta/answer tools are always exempt so the agent can
      // still finish, ask, or load another skill's docs.
      if (
        ctx.skillToolRestriction &&
        !ctx.skillToolRestriction.has(action.action as AIAgentToolName) &&
        SKILL_RESTRICTION_ESSENTIAL_TOOLS[action.action] !== true
      ) {
        const allowed = [...ctx.skillToolRestriction].sort().join(", ");
        return agentToolError(
          `the active skill restricts tools to [${allowed}] (plus finish, ask_user, update_plan, read_page, skill, read_skill_resource). "${action.action}" is disabled while that skill is loaded — use an allowed tool or finish.`,
        );
      }
      // P10 read-only policy, layer 3: an unattended scheduled run may only use
      // the read tool surface. The catalog filter already keeps these out of the
      // request (layers 1 and 2), so reaching this branch means the model named a
      // blocked tool anyway — refuse it with a corrective observation instead of
      // executing it, and never lean on the catalog filter being correct.
      if (unattendedReadOnly && !isUnattendedAllowedTool(action.action)) {
        // `action.action` also carries legacy names the allow-list cannot know;
        // any of them is a blocked tool by definition (fail-closed).
        unattendedBlockedToolsUsed.add(action.action as AIAgentToolName);
        return unattendedToolBlockReason(action.action);
      }
      // Repeating an exploration call with identical arguments returns the
      // identical observation and burns a step from a tight budget. Meta actions
      // (update_plan re-posts the whole checklist by design) and delegate (which
      // has its own per-run budget) are exempt.
      const explorationKey =
        action.action !== "run_readonly_sql" &&
        action.action !== "run_parameterized_sql" &&
        action.action !== "find_value" &&
        action.action !== "sample_table_data" &&
        action.action !== "read_page" &&
        action.action !== "update_plan" &&
        action.action !== "delegate" &&
        action.action !== "create_checkpoint"
          ? `${action.action}:${JSON.stringify(action.args ?? {})}`
          : "";
      if (explorationKey && explorationKey === lastExplorationToolKey) {
        const varyHint =
          action.action === "list_tables"
            ? ' Narrow with args {"pattern":"substring"} or {"schema":"..."}, or raise {"limit":200}.'
            : " Vary the arguments or move on to the next step.";
        return `Tool notice: identical ${action.action} call repeated — vary the arguments or continue.${varyHint}`;
      }
      if (explorationKey) {
        lastExplorationToolKey = explorationKey;
      }

      // Per-run result cache: an identical read call returns the archived
      // observation instead of re-hitting the backend. Checked after the
      // policy guards so a cached result can never bypass a restriction that
      // was armed after the original call ran.
      const cacheKey = agentToolCacheKey(action);
      if (cacheKey) {
        const cached = toolResultCache.get(cacheKey);
        if (cached) {
          frame.full = cached.full;
          return `${cached.trace}\n[cached — identical ${action.action} call already ran in this run]`;
        }
      }

      const handler = AGENT_TOOL_HANDLERS[action.action];
      if (handler) {
        return await handler(ctx, (action.args ?? {}) as Record<string, unknown>, frame);
      }

      // Unknown action: never say "finish" here — the model needs the list of
      // valid tools to self-correct (a bare "unknown tool" makes small models
      // loop).
      if (action.action === "finish") {
        return agentToolError("finish does not execute a tool observation.");
      }
      const availableTools = AI_AGENT_TOOL_NAMES.filter(
        (toolName) =>
          toolName !== "finish" && (!unattendedReadOnly || isUnattendedAllowedTool(toolName)),
      ).join(", ");
      return agentToolError(
        `unknown tool "${action.action}". Available tools: ${availableTools}. Choose one of these, or return a finish action with args.response if the task is complete.`,
      );
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) {
        throw errorValue;
      }
      return agentToolError(formatExecutionError(errorValue), {
        hint: agentSqlErrorHint(errorValue),
        retryable: isRetryableAgentToolError(errorValue),
      });
    }
  };

  /**
   * Executes one tool call end-to-end: fresh frame, dispatch, archive, audit
   * trace, per-run cache store, and schema-summary invalidation. Shared by
   * single actions and batch sub-calls so both paths keep identical
   * bookkeeping.
   */
  const runSingleToolCall = async (action: AIAgentToolAction): Promise<string> => {
    const frame: AgentToolCallFrame = { full: null, sql: null };
    const startedAt = performance.now();
    try {
      const result = await dispatchAgentTool(action, frame);
      ctx.observationArchive.push({
        action: action.action,
        full: frame.full ?? result,
      });
      const ok = !result.startsWith("Tool error") && !result.startsWith("Tool blocked");
      runTrace.push({
        tool: action.action as AIWorkspaceRunTraceEntry["tool"],
        argsSummary: summarizeToolCallArgs(action),
        ms: Math.max(0, Math.round(performance.now() - startedAt)),
        ok,
        sql: extractToolCallSql(action) ?? frame.sql ?? undefined,
      });
      const cacheKey = agentToolCacheKey(action);
      if (cacheKey && ok) {
        toolResultCache.set(cacheKey, { trace: result, full: frame.full ?? result });
      }
      // A successful state-changing call can stale every cached read from
      // earlier in the run — drop the whole per-run cache.
      if (ok && CACHE_INVALIDATING_AGENT_TOOLS[action.action] === true) {
        toolResultCache.clear();
      }
      // Schema-affecting calls (write previews, user-applied SQL proposals,
      // checkpoint restores) can change what the auto-injected schema summary
      // describes — drop the cached summary so the next run refetches instead
      // of serving a pre-change catalog inside the TTL window.
      if (isSchemaAffectingAgentAction(action.action) && ok) {
        invalidateAgentSchemaSummary(connectionId ?? undefined);
      }
      return result;
    } catch (errorValue) {
      // A thrown dispatch (e.g. superseded request) still belongs in the audit
      // trail: the run died mid-call and the trace must not pretend otherwise.
      runTrace.push({
        tool: action.action as AIWorkspaceRunTraceEntry["tool"],
        argsSummary: summarizeToolCallArgs(action),
        ms: Math.max(0, Math.round(performance.now() - startedAt)),
        ok: false,
        sql: extractToolCallSql(action) ?? frame.sql ?? undefined,
      });
      throw errorValue;
    }
  };

  /**
   * Executes a `batch` action: consecutive read-only sub-calls run
   * concurrently (Promise.allSettled), mutating/ordering-sensitive and
   * user-facing calls serialize in array order. Results are reported in the
   * original call order regardless of execution interleaving.
   */
  const runBatchAction = async (action: AIAgentToolAction): Promise<string> => {
    const batchStartedAt = performance.now();
    const rawCalls = Array.isArray((action.args as AIAgentBatchArgs | undefined)?.calls)
      ? (action.args as AIAgentBatchArgs).calls
      : [];
    if (rawCalls.length === 0) {
      return agentToolError("batch requires a non-empty args.calls array.", {
        hint: 'Send args.calls like [{"action":"describe_table","args":{"table":"orders"}}].',
      });
    }
    if (rawCalls.length > AI_AGENT_BATCH_CALL_LIMIT) {
      return agentToolError(
        `batch accepts at most ${AI_AGENT_BATCH_CALL_LIMIT} calls per step — split the rest into the next step.`,
      );
    }
    const calls = rawCalls.map((raw: unknown): AIAgentBatchCall => {
      const entry = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      return {
        action: typeof entry.action === "string" ? entry.action.trim() : "",
        args:
          entry.args && typeof entry.args === "object" && !Array.isArray(entry.args)
            ? (entry.args as Record<string, unknown>)
            : {},
      };
    });

    const runOne = async (call: AIAgentBatchCall): Promise<string> => {
      if (!call.action || !(AI_AGENT_TOOL_NAMES as readonly string[]).includes(call.action)) {
        return agentToolError(
          `batch call has unknown or missing action "${call.action || "(empty)"}".`,
          { hint: `Use one of: ${AI_AGENT_TOOL_NAMES.join(", ")}.` },
        );
      }
      if (BATCH_FORBIDDEN_TOOLS[call.action] === true) {
        return agentToolError(`"${call.action}" cannot ride a batch — send it as its own step.`);
      }
      return runSingleToolCall({
        action: call.action,
        args: call.args,
        message: "",
      } as AIAgentToolAction);
    };

    const results = new Array<string>(calls.length);
    let index = 0;
    while (index < calls.length) {
      const call = calls[index];
      if (BATCH_PARALLEL_TOOLS[call.action] === true) {
        // Gather the run of consecutive parallel-eligible calls and execute
        // them together; allSettled keeps one failure from cancelling siblings.
        let end = index + 1;
        while (end < calls.length && BATCH_PARALLEL_TOOLS[calls[end].action] === true) {
          end += 1;
        }
        const settled = await Promise.allSettled(
          calls.slice(index, end).map((entry: AIAgentBatchCall) => runOne(entry)),
        );
        settled.forEach((outcome: PromiseSettledResult<string>, offset: number) => {
          if (outcome.status === "fulfilled") {
            results[index + offset] = outcome.value;
          } else {
            if (isSupersededAIRequestError(outcome.reason)) throw outcome.reason;
            results[index + offset] = agentToolError(formatExecutionError(outcome.reason));
          }
        });
        index = end;
      } else {
        results[index] = await runOne(call);
        index += 1;
      }
    }

    const full = results
      .map(
        (result, callIndex) =>
          `--- call ${callIndex + 1}: ${calls[callIndex].action} ---\n${result}`,
      )
      .join("\n\n");
    ctx.observationArchive.push({ action: "batch", full });
    runTrace.push({
      tool: "batch",
      argsSummary: `${calls.length} calls`,
      ms: Math.max(0, Math.round(performance.now() - batchStartedAt)),
      ok: results.every(
        (result) => !result.startsWith("Tool error") && !result.startsWith("Tool blocked"),
      ),
    });
    return truncateAgentObservation(full);
  };

  const runAgentTool = async (action: AIAgentToolAction): Promise<string> => {
    if (action.action === "batch") {
      return runBatchAction(action);
    }
    return runSingleToolCall(action);
  };

  /** Copy of the run's tool-call audit trail, in execution order. */
  const getRunTrace = (): AIWorkspaceRunTraceEntry[] => runTrace.map((entry) => ({ ...entry }));

  /**
   * Report of every attempt to use a blocked tool during an unattended run.
   * Empty for a normal run, so a caller can assert read-only compliance from
   * evidence instead of trusting the allow-list alone.
   */
  const getUnattendedBlockedTools = (): AIAgentToolName[] => [...unattendedBlockedToolsUsed].sort();

  return { runAgentTool, getUnattendedBlockedTools, getRunTrace };
}
