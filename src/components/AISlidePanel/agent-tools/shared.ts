/**
 * Shared contracts for the agent tool registry (agent-tools/). Each tool
 * module registers a { name, handler } pair; the executor
 * (ai-agent-tool-executor.ts) owns the run state, applies the policy guards,
 * and dispatches through the registry. Tool schemas stay in
 * tool-schema/specs.ts — this file only carries the runtime plumbing types.
 */
import { stringifyAgentObservationFull, truncateAgentObservation } from "../ai-agent-grounding";
import type { AIAgentToolName } from "../ai-agent-tools";
import type { AgentToolExecutorDeps } from "../ai-agent-tool-executor";

/**
 * Per-call mutable slot: the full (untruncated) observation a call produced
 * and any SQL it built internally (find_value, run_preset). Lives in a frame
 * object instead of closure variables so parallel batch sub-calls can never
 * overwrite each other's pending state.
 */
export interface AgentToolCallFrame {
  full: string | null;
  sql: string | null;
}

/**
 * Everything a tool handler may touch: the executor deps (connections,
 * consent hooks, engine gates) plus the mutable per-run state the guards and
 * budgets live in. One context object is shared by every call in a run, so a
 * handler mutating `skillToolRestriction` or a budget counter is observed by
 * the executor's guards on the next call.
 */
export interface AgentToolContext extends AgentToolExecutorDeps {
  /** Side-analysis calls spent this run (delegate budget). */
  delegateCallsUsed: number;
  /** Local checkpoint snapshots created this run (safety budget). */
  checkpointCallsUsed: number;
  /** Rollback confirmations driven this run (one per run). */
  restoreCallsUsed: number;
  /**
   * Skills loaded this run mapped to the bundled resource paths each one
   * declared. read_skill_resource is fail-closed against this: a resource is
   * only readable when its skill was loaded this run AND the path was listed
   * by that skill, so the agent can never fetch an arbitrary file off disk.
   */
  loadedSkillResources: Map<string, Set<string>>;
  /**
   * Union of `allowed-tools:` declared by loaded skills. Once any loaded skill
   * declares a restriction, the run is confined to that set plus the essential
   * meta/answer tools — the same guardrail Claude Code applies per skill.
   */
  skillToolRestriction: Set<AIAgentToolName> | null;
  /**
   * Mutating statements successfully previewed this run (normalized). The
   * edit_query_sql gate only accepts proposals for statements the agent has
   * smoke-tested through preview_write's rollback transaction.
   */
  previewedMutatingStatements: Set<string>;
  /**
   * Full (untruncated) observations from this run, 1-based-indexed in call
   * order. The trace the model sees truncates at ~1400 chars; read_page
   * re-reads the archived original at zero cost.
   */
  observationArchive: Array<{ action: string; full: string }>;
  /**
   * Best-effort pre-write checkpoint: the first mutating preview_write /
   * edit_query_sql of a run snapshots the database under the "agent-pre-write"
   * label so a bad proposal is one /rollback away from undone. Runs once per
   * run; a failure warns inside the tool observation but never blocks.
   */
  ensurePreWriteCheckpoint: () => Promise<string>;
  /** "Did you mean" hint for a table name that matched nothing in the schema. */
  tableNotFoundHint: (requested: string) => string | undefined;
}

/** One registered tool: the catalog name plus the handler that runs it. */
export interface AgentToolModule {
  name: string;
  handler: AgentToolHandler;
}

export type AgentToolHandler = (
  ctx: AgentToolContext,
  args: Record<string, unknown>,
  frame: AgentToolCallFrame,
) => Promise<string>;

// Tools a loaded skill's `allowed-tools:` restriction can never take away: the
// agent always keeps the meta/answer tools so a restrictive skill cannot brick
// the run or trap it without a way to finish or load another skill's docs.
export const SKILL_RESTRICTION_ESSENTIAL_TOOLS: Record<string, true> = {
  finish: true,
  ask_user: true,
  update_plan: true,
  read_page: true,
  skill: true,
  read_skill_resource: true,
};

/** Archives the full observation and returns the truncated trace version. */
export const stringifyAgentObservation = (frame: AgentToolCallFrame, data: unknown): string => {
  const full = stringifyAgentObservationFull(data);
  frame.full = full;
  return truncateAgentObservation(full);
};
