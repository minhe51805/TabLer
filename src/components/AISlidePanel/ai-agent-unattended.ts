/**
 * P10 read-only policy for unattended agent runs (scheduled agent tasks).
 *
 * A scheduled agent task runs while nobody is watching. The approved contract
 * is option 2: the run may READ and RECORD, but it may never change anything —
 * not the database, not the app's memory/rules/skills, and not a checkpoint it
 * could later roll back to. Findings survive the run through the P8 insight
 * store (persisted) and the P9 learning offers (proposals a human approves);
 * nothing is written on the agent's own authority.
 *
 * The policy is enforced in three independent places, so a single gap can never
 * be enough to let a write through:
 *
 *  1. the native function-calling payload (`buildNativeToolPayload`),
 *  2. the prompt-text tool catalog (`formatAgentToolCatalog`),
 *  3. the executor itself (`createAgentToolExecutor`), which refuses a blocked
 *     tool by name even if a model hallucinates it.
 *
 * Kept in its own module (AISlidePanel rule: one file per concern) and depending
 * only on the import-free tool-schema constants, so the catalog modules can
 * import it without a cycle.
 */
import { AI_AGENT_TOOL_NAMES, type AIAgentToolName } from "./tool-schema/constants";

/**
 * The complete tool surface of an unattended run. Everything an agent needs to
 * investigate a question and report back, and nothing that can change state.
 *
 * `sample_table_data` / `run_readonly_sql` / `run_parameterized_sql` / `find_value`
 * / `run_preset` are reads. `read_memory` reads. `skill` and `read_skill_resource`
 * load instructions. `delegate` is a read-only side model call. `read_page`
 * re-reads this run's own archived observations. `update_plan`, `read_page` and
 * `finish` are loop mechanics.
 */
export const UNATTENDED_READ_ONLY_TOOLS: readonly AIAgentToolName[] = [
  "update_plan",
  "list_tables",
  "search_schema",
  "list_schema_objects",
  "describe_table",
  "describe_tables",
  "sample_table_data",
  "run_readonly_sql",
  "run_parameterized_sql",
  "find_value",
  "check_sql",
  "run_preset",
  "read_memory",
  "skill",
  "read_skill_resource",
  "delegate",
  "read_page",
  "finish",
];

const UNATTENDED_ALLOWED_TOOL_SET: ReadonlySet<string> = new Set<string>(
  UNATTENDED_READ_ONLY_TOOLS,
);

/**
 * Tools an unattended run must never reach, with the reason reported back as the
 * step's observation. Derived from the canonical name list so adding a tool in
 * `tool-schema/constants.ts` automatically lands here (fail-closed) instead of
 * silently becoming callable unattended.
 */
export const UNATTENDED_BLOCKED_TOOLS: readonly AIAgentToolName[] = AI_AGENT_TOOL_NAMES.filter(
  (name) => !UNATTENDED_ALLOWED_TOOL_SET.has(name),
);

export function isUnattendedAllowedTool(name: string): boolean {
  return UNATTENDED_ALLOWED_TOOL_SET.has(name);
}

/**
 * The observation an unattended run gets when it calls something it may not use.
 * Written as an instruction rather than a bare "blocked", so the loop corrects
 * itself (reads and reports instead of retrying the same blocked call).
 */
export function unattendedToolBlockReason(name: string): string {
  if (name === "ask_user") {
    return "Tool blocked: this run is an unattended scheduled task — no human is present to answer. Decide with the evidence you can read (list_tables, search_schema, describe_table, sample_table_data, run_readonly_sql) and finish with a report of what you found and what still needs a human.";
  }
  if (name === "preview_write" || name === "propose_seed_data" || name === "edit_query_sql") {
    return "Tool blocked: unattended scheduled runs are read-only. They never change data or propose SQL edits — record what you found instead, and the user can act on it interactively.";
  }
  if (name === "remember_term" || name === "save_memory" || name === "delete_memory") {
    return "Tool blocked: unattended scheduled runs cannot change stored memory or the glossary. Report the finding; the user approves any knowledge the workspace keeps.";
  }
  if (name === "create_checkpoint" || name === "restore_checkpoint") {
    return "Tool blocked: checkpoints and rollbacks need a human in the loop, so an unattended run cannot create or restore one.";
  }
  return `Tool blocked: "${name}" is not part of the read-only tool surface of an unattended scheduled run. Use the read tools available to this run and finish with your findings.`;
}
