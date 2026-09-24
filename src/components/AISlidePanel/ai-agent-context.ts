import type { TableInfo } from "../../types";
import { AI_SCHEMA_CODEC_VERSION, type AISchemaCodecMode } from "./AISlidePanelUtils";
import type { AIWorkspaceAgentActionName, AIWorkspaceAgentStep } from "./ai-workspace-types";

export type AssistIntent = "sql" | "explain" | "overview" | "optimize" | "fix-error" | "general";

/**
 * Repeat-call detection (learned from deepseek-harness `repeat-tool-reminder`):
 * actions that carry tool arguments participate in the consecutive-repeat
 * chain; meta actions (plan/think/finish/ask_user) are transparent — they
 * neither count nor reset the chain.
 */
const UNTRACKED_REPEAT_ACTIONS = new Set<AIWorkspaceAgentActionName>([
  "plan",
  "think",
  "ask_user",
  // Re-posting the checklist with updated statuses is the intended rhythm,
  // not a wasted repeat — the plan replaces (not re-derives) state.
  "update_plan",
  // Checkpoints are cheap local snapshots; the executor caps them per run.
  "create_checkpoint",
  "restore_checkpoint",
  "finish",
]);

/** One checklist entry posted through the update_plan tool. */
export interface AgentPlanStep {
  title: string;
  status: "pending" | "in_progress" | "done";
}

export function isRepeatTrackedAction(action: AIWorkspaceAgentActionName): boolean {
  return !UNTRACKED_REPEAT_ACTIONS.has(action);
}

/** Deep key-sort so two argument objects differing only in property order canonicalize identically. */
function sortAgentArgsValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortAgentArgsValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortAgentArgsValue(record[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalizeAgentArgs(args: unknown): string {
  return JSON.stringify(sortAgentArgsValue(args));
}

/** Head-truncate the canonical args quoted in the detailed reminder. */
export function previewAgentArgs(canonicalArgs: string, cap = 500): string {
  if (canonicalArgs.length <= cap) return canonicalArgs;
  return `${canonicalArgs.slice(0, cap)}… (+${canonicalArgs.length - cap} more chars)`;
}

export const REPEAT_CALL_GENTLE_REMINDER =
  "You are repeating the exact same tool call with identical arguments. " +
  "Carefully analyze the previous result before calling again: if the task is " +
  "not complete, try a different approach or different arguments instead of " +
  "repeating the call.";

export function repeatCallDetailedReminder(
  action: AIWorkspaceAgentActionName,
  count: number,
  argsPreview: string,
): string {
  return (
    "Repeated tool call detected:\n" +
    `- tool: ${action}\n` +
    `- consecutive_calls: ${count}\n` +
    `- arguments: ${argsPreview}\n` +
    "The repeated calls are not making progress. Do not call this tool with " +
    "these exact arguments again. Inspect the latest result and choose a " +
    "different action, different arguments, or finish the task if enough " +
    "evidence has been gathered."
  );
}

/**
 * A tool observation is a FAILURE when the executor returned a "Tool error"
 * or "Tool blocked" string instead of real evidence (same convention
 * hasExecutedReadStep uses in ai-agent-quality-gates).
 */
export function isFailedToolObservation(observation: string): boolean {
  const trimmed = observation.trimStart();
  return trimmed.startsWith("Tool error") || trimmed.startsWith("Tool blocked");
}

/** Consecutive failed tool observations that trigger a mid-run reflection. */
export const TOOL_ERROR_REFLECTION_THRESHOLD = 3;

/**
 * Counts how many of the most recent EXECUTED tool steps failed in an
 * unbroken streak. Meta steps (plan/think/update_plan/checkpoints — they carry
 * no real tool observation) are transparent: they neither count as a failure
 * nor reset the streak, matching the repeat-call chain's meta transparency. Any
 * successful tool observation ends the streak.
 *
 * Unlike the repeat-call guard (which only fires when the SAME call repeats),
 * this catches a run grinding through DIFFERENT calls that all fail, so the
 * controller can be nudged to step back and re-strategize.
 */
export function countTrailingToolErrors(steps: AgentTraceStep[]): number {
  let count = 0;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!isRepeatTrackedAction(step.action)) continue;
    if (isFailedToolObservation(step.observation)) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

/**
 * A "step back and re-strategize" instruction appended to the next controller
 * prompt after a streak of failing tool calls. It asks the model to state what
 * it has learned, name the shared blocker, and switch approach (different tool,
 * corrected args, narrower query, ask_user) — or finish honestly when the
 * data/capability is genuinely unavailable.
 */
export function toolErrorReflectionNudge(consecutiveErrors: number): string {
  return (
    `Reflection checkpoint: your last ${consecutiveErrors} tool calls in a row all failed ` +
    "(Tool error / Tool blocked). Stop repeating the same approach and re-strategize before the next call: " +
    "(1) briefly state what you have actually confirmed so far from the observations above; " +
    "(2) name the specific blocker these errors share; " +
    "(3) choose a DIFFERENT approach that avoids it — a different tool, corrected arguments, a narrower query, " +
    "or ask_user if the request is ambiguous. " +
    "If the errors mean the data or capability is genuinely unavailable, finish now with an honest explanation instead of retrying."
  );
}

/**
 * Merge run-time notes (manual provider switches, chain failovers, retry
 * waits) into the runner's step trace, renumbering sequentially so the stored
 * list has stable, unique ordinals — the persisted bubble format is the same
 * `agentSteps` array, so notes survive reloads through the normal path.
 */
export function mergeRunNotes(
  steps: AIWorkspaceAgentStep[],
  notes: AgentTraceStep[],
): AIWorkspaceAgentStep[] {
  const merged: AIWorkspaceAgentStep[] = [
    ...steps,
    ...notes.map((note) => ({
      step: note.step,
      action: note.action,
      message: note.message,
      observation: note.observation,
      status: "done" as const,
    })),
  ];
  merged.forEach((step, index) => {
    step.step = index + 1;
  });
  return merged;
}

export interface AgentTraceStep {
  step: number;
  action: AIWorkspaceAgentActionName;
  message: string;
  observation: string;
  /** Machine-readable facts extracted from the observation (Phase: structured evidence). */
  facts?: AgentStepFacts;
}

export interface AgentColumnStats {
  column: string;
  nullRatio: number;
  distinctCount: number;
}

export interface AgentStepFacts {
  rowsReturned?: number;
  tables?: string[];
  columnStats?: AgentColumnStats[];
  /**
   * The statement this step executed together with the row count it saw (P8).
   *
   * Written only where a statement genuinely ran, never derived from the
   * observation: the insight engine treats this pair as proof and refuses to
   * emit a finding without it. Both values travel together in one object so a
   * SQL text can never be stored without the count it produced.
   */
  insightEvidence?: AgentStepEvidence;
}

/**
 * Evidence a proactive insight is allowed to cite. `rowCount` is the number of
 * rows the evidence statement itself saw — for an aggregate that is the table's
 * row count, not the size of a sample.
 */
export interface AgentStepEvidence {
  executedSql: string;
  rowCount: number;
}

/** Footer marker appended to observations carrying machine-readable facts. */
const AGENT_FACTS_PREFIX = "@@facts:";

/** Appends a machine-readable facts footer that survives with the trace. */
export function appendAgentFacts(observation: string, facts: AgentStepFacts): string {
  if (Object.keys(facts).length === 0) return observation;
  return `${observation}\n${AGENT_FACTS_PREFIX}${JSON.stringify(facts)}`;
}

/** Splits an observation into its display text and embedded facts, if any. */
export function parseAgentFacts(observation: string): {
  text: string;
  facts: AgentStepFacts | null;
} {
  const index = observation.lastIndexOf(`\n${AGENT_FACTS_PREFIX}`);
  if (index === -1) return { text: observation, facts: null };
  const raw = observation.slice(index + 1 + AGENT_FACTS_PREFIX.length);
  try {
    const parsed = JSON.parse(raw) as AgentStepFacts;
    if (parsed && typeof parsed === "object") {
      return { text: observation.slice(0, index), facts: parsed };
    }
  } catch {
    // Malformed footer — treat the whole observation as plain text.
  }
  return { text: observation, facts: null };
}

/** Convenience accessor used by quality gates: facts or null. */
export function readStepFacts(step: AgentTraceStep): AgentStepFacts | null {
  if (step.facts) return step.facts;
  const { facts } = parseAgentFacts(step.observation);
  return facts;
}

export const AI_SCHEMA_CODEC_LEGEND =
  "Legend T=table C=col:type!flags I=index F=fk flags=pk|nn|df|ai";
const MAX_SCHEMA_CAPSULE_PREVIEW_TABLES = 4;

export function clampObservationText(text: string, budget: number) {
  const flat = text.trim();
  if (flat.length <= budget) return flat;
  return `${flat.slice(0, budget)}\n[observation truncated]`;
}

function normalizeName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Detects a database name the user explicitly mentions that differs from the
 * database this workspace is bound to (or the one currently open). Returns the
 * mentioned name, or null when there is no conflict.
 */
export function detectDatabaseMentionMismatch(params: {
  userPrompt: string;
  knownDatabaseNames?: string[];
  boundDatabase: string | null;
}): string | null {
  const { userPrompt, knownDatabaseNames, boundDatabase } = params;
  if (!userPrompt.trim() || !knownDatabaseNames || knownDatabaseNames.length === 0) return null;
  const normalizedPrompt = ` ${userPrompt.toLowerCase().replace(/\s+/g, " ")} `;
  for (const name of knownDatabaseNames) {
    const clean = name.trim().toLowerCase();
    if (!clean || clean === (boundDatabase ?? "").trim().toLowerCase()) continue;
    if (clean === "default") continue;
    // Word-boundary match so "sales" does not fire inside "salestrends".
    const pattern = new RegExp(
      `(^|[^a-z0-9_])${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`,
    );
    if (pattern.test(normalizedPrompt)) return name;
  }
  return null;
}

export function buildWorkspaceTableIdentifier(
  table: Pick<TableInfo, "name" | "schema">,
  currentDatabase: string | null,
) {
  const tableName = table.name.trim();
  if (!tableName || tableName.includes(".")) return tableName;

  const schemaName = table.schema?.trim();
  if (!schemaName) return tableName;
  if (currentDatabase && normalizeName(schemaName) === normalizeName(currentDatabase)) {
    return tableName;
  }

  return `${schemaName}.${tableName}`;
}

export function buildAgentVisibleTableNames(
  allTableNames: string[],
  prioritizedTableNames: string[],
  limit: number,
) {
  const visibleTableNames: string[] = [];
  const seen = new Set<string>();

  for (const tableName of [...prioritizedTableNames, ...allTableNames]) {
    const normalized = normalizeName(tableName);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    visibleTableNames.push(tableName);
    if (visibleTableNames.length >= limit) break;
  }

  return visibleTableNames;
}

export function buildSchemaCapsulePreview(
  tableSchemas: string[],
  limit = MAX_SCHEMA_CAPSULE_PREVIEW_TABLES,
) {
  return tableSchemas.slice(0, limit).join("\n");
}

export function buildSchemaCapsuleContext(params: {
  currentDatabase: string | null;
  totalTableCount: number;
  visibleTableNames: string[];
  allVisible: boolean;
  tableSchemas: string[];
  schemaCodecMode: AISchemaCodecMode;
  truncatedOverview: boolean;
}) {
  const {
    currentDatabase,
    totalTableCount,
    visibleTableNames,
    allVisible,
    tableSchemas,
    schemaCodecMode,
    truncatedOverview,
  } = params;

  return [
    "Workspace schema capsule:",
    `DB=${currentDatabase || "Default"}`,
    `TC=${totalTableCount}`,
    `TV=${visibleTableNames.join(",")}${allVisible ? "" : ",..."}`,
    `SCHEMA=${AI_SCHEMA_CODEC_VERSION}|mode=${schemaCodecMode}|rowdata=0`,
    AI_SCHEMA_CODEC_LEGEND,
    ...tableSchemas,
    truncatedOverview ? "NOTE=Overview limited to current capsule tables." : "",
    "RULE=Use only tables in TV or capsule lines. Ask if a needed table is missing.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildAgentRecoveryContext(params: {
  currentDatabase: string | null;
  availableTableNames: string[];
  visibleTableNames: string[];
  schemaCapsulePreview: string;
}) {
  const { currentDatabase, availableTableNames, visibleTableNames, schemaCapsulePreview } = params;
  return [
    `DB=${currentDatabase || "Default"}`,
    `TC=${availableTableNames.length}`,
    `TV=${visibleTableNames.join(",")}${availableTableNames.length > visibleTableNames.length ? ",..." : ""}`,
    schemaCapsulePreview ? `SCHEMA_PREVIEW=\n${schemaCapsulePreview}` : "",
    "RULE=list_tables for catalog; search_schema for unknown fields; describe_table before assuming columns; stay inside verified schema.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function joinAgentInstructions(...parts: Array<string | undefined>) {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ");
}
