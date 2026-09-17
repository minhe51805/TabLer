/**
 * Learning loop (P9).
 *
 * A run that proved something is worth more than one answer: this module turns
 * what a run *learned* into the three things the app can keep — a memory entry,
 * a guardrail rule, a skill — and hands them to the user for approval.
 *
 * Two rules, same spirit as the insight engine it consumes:
 *
 * 1. **Nothing is written without a click.** `proposeRunLearnings` only
 *    produces proposals; `applyLearningProposal` runs only from the card the
 *    user approved. This is the difference between this loop and the
 *    `remember_term` tool, where the model writes memory mid-run.
 * 2. **A proposal cites the run that justified it.** Every card carries the
 *    executed statement (when one ran) or the observed step sequence, and the
 *    detector that cannot point at either emits nothing — a skill whose body is
 *    invented from a two-step run, or a rule learned from a column name the run
 *    never touched, is noise the user has to read before rejecting.
 */

import { countTrailingToolErrors, readStepFacts, type AgentTraceStep } from "./ai-agent-context";
import type { AgentInsight } from "./ai-agent-insights";

/** How many proposals one run may raise. A learning loop that shouts is ignored. */
export const LEARNING_MAX_PROPOSALS = 4;
/** A procedure needs this many steps before calling it one is honest. */
export const MIN_SKILL_STEPS = 4;
/** Per-run caps per kind: findings are many, guardrails must stay few. */
export const MAX_LEARNING_MEMORIES_PER_RUN = 2;
export const MAX_LEARNING_RULES_PER_RUN = 1;

export type LearningKind = "rule" | "memory" | "skill";

/** What a memory proposal writes through `save_agent_memory`. */
export interface LearningMemoryPayload {
  name: string;
  description: string;
  body: string;
}

/** What a rule proposal writes through `save_agent_rule`. */
export interface LearningRulePayload {
  name: string;
  description: string;
  event: "pre_read" | "pre_write" | "any";
  action: "warn" | "require_approval" | "block";
  pattern: string;
}

/** What a skill proposal writes through `create_ai_skill`. */
export interface LearningSkillPayload {
  name: string;
  description: string;
  body: string;
}

/**
 * One thing the run could teach the workspace. Discriminated on `kind` so the
 * applier cannot confuse a rule with a skill payload.
 */
export type LearningProposal =
  | (LearningProposalBase & { kind: "rule"; rule: LearningRulePayload })
  | (LearningProposalBase & { kind: "memory"; memory: LearningMemoryPayload })
  | (LearningProposalBase & { kind: "skill"; skill: LearningSkillPayload });

interface LearningProposalBase {
  /** Stable id: `${kind}:${source}` — the dedupe key and the card key. */
  id: string;
  /** Card headline, e.g. `Remember that users.deleted_at is never populated`. */
  title: string;
  /** Why the run justifies this, quoting what was observed. */
  rationale: string;
  /** The statement behind the proposal, when one executed. */
  evidenceSql?: string;
}
/** A name every store accepts: memory, rule and skill names all become paths. */
export function buildLearningSlug(...parts: readonly string[]): string {
  const slug = parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // The cut can land on a separator, so trim once more after slicing.
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "run-note";
}

/** Only a plain identifier may be embedded in a rule pattern. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Escape an identifier so a rule matches it literally. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A finding becomes a memory entry: the fact, the statement that proved it and
 * how much data stood behind it. Future runs then start from the fact instead of
 * re-deriving it — which is the whole point of keeping it.
 */
function proposeMemoryFromInsight(insight: AgentInsight): LearningProposal {
  const body = [
    "## Verified finding",
    "",
    insight.detail,
    "",
    "## Evidence",
    "",
    `Observed ${insight.evidence.rowCount} row(s) with:`,
    "",
    "```sql",
    insight.evidence.executedSql,
    "```",
    "",
    `Confidence ${insight.confidence}% (computed from the observation, not claimed).`,
  ].join("\n");
  return {
    id: `memory:${insight.id}`,
    kind: "memory",
    title: `Remember that ${insight.table}${insight.column ? `.${insight.column}` : ""} behaves this way`,
    rationale: `The run proved it by reading ${insight.evidence.rowCount} row(s); saving it means the next run starts from the fact.`,
    evidenceSql: insight.evidence.executedSql,
    memory: {
      name: buildLearningSlug(insight.table, insight.column ?? "table", insight.kind),
      description: insight.title,
      body,
    },
  };
}

/**
 * A finding becomes a guardrail rule — but only where a pattern can be written
 * without guessing. A finding with no column (or with an identifier no SQL could
 * mention verbatim) gets no rule: a rule that cannot match is an inert guardrail,
 * which is worse than none.
 */
function proposeRuleFromInsight(insight: AgentInsight): LearningProposal | null {
  const column = insight.column;
  if (!column || !SAFE_IDENTIFIER.test(column)) return null;
  return {
    id: `rule:${insight.id}`,
    kind: "rule",
    title: `Warn whenever SQL touches ${insight.table}.${column}`,
    rationale: `The run proved this column is effectively unused (${insight.confidence}% confidence over ${insight.evidence.rowCount} rows). A warn-only rule surfaces the next query that leans on it without blocking anyone.`,
    evidenceSql: insight.evidence.executedSql,
    rule: {
      name: buildLearningSlug("flagged-column", insight.table, column),
      description: `${insight.table}.${column} is effectively unused: ${insight.title}. Warn so the next query on it is reviewed.`,
      // Reads only, and never blocking: this rule exists to inform, and a
      // guardrail learned from an observation must not be able to refuse work.
      event: "pre_read",
      action: "warn",
      pattern: `(?i)\\b${escapeRegex(column)}\\b`,
    },
  };
}

/**
 * A clean, multi-step run becomes a skill — the only way a procedure can be
 * learned from the outside.
 *
 * Three gates, all of them there to stop the loop from manufacturing
 * documentation: the run must be long enough to be a procedure, it must have
 * ended without an error, and at least one step must have executed a read. A
 * "procedure" made of model reasoning is not repeatable, so it is not saved.
 */
function proposeSkillFromRun(
  steps: readonly AgentTraceStep[],
  table: string,
): LearningProposal | null {
  if (steps.length < MIN_SKILL_STEPS) return null;
  // The runner's streak counter takes a mutable slice; the trace stays ours.
  if (countTrailingToolErrors([...steps]) > 0) return null;
  const workSteps = steps.filter((step) => step.action !== "think" && step.action !== "finish");
  if (workSteps.length < MIN_SKILL_STEPS) return null;
  const executedReads = workSteps.filter((step) => readStepFacts(step)?.insightEvidence);
  if (executedReads.length === 0) return null;

  const body = [
    "## What I do",
    "",
    `Repeat the check this run performed on \`${table}\`.`,
    "",
    "## Steps",
    "",
  ];
  workSteps.forEach((step, index) => {
    body.push(`${index + 1}. \`${step.action}\` — ${step.message.trim() || "no note"}`);
    const evidence = readStepFacts(step)?.insightEvidence;
    if (evidence) {
      body.push("", "   ```sql", `   ${evidence.executedSql}`, "   ```", "");
    }
  });
  body.push(
    "",
    "## Notes",
    "",
    "Learned from a completed run; verify the steps still apply before relying on them.",
  );

  return {
    id: `skill:${table}:${workSteps.length}`,
    kind: "skill",
    title: `Save this ${workSteps.length}-step check of ${table} as a skill`,
    rationale: `The run finished clean in ${workSteps.length} steps and executed ${executedReads.length} read(s). A skill lets the next session replay the procedure instead of rediscovering it.`,
    skill: {
      name: buildLearningSlug("check", table),
      description: `Repeat the ${workSteps.length}-step check of ${table} that a completed run performed.`,
      body: body.join("\n"),
    },
  };
}

/** Facts' table list is the fallback when a run produced no insight. */
function firstTableFromSteps(steps: readonly AgentTraceStep[]): string | null {
  for (const step of steps) {
    const table = readStepFacts(step)?.tables?.find(
      (name) => typeof name === "string" && name.trim(),
    );
    if (table) return table.trim();
  }
  return null;
}

/** Everything one finished run could teach, strongest first. */
export function proposeRunLearnings(input: {
  insights: readonly AgentInsight[];
  steps: readonly AgentTraceStep[];
}): LearningProposal[] {
  const { insights, steps } = input;

  // `insights` arrives sorted by confidence, so the leading entries are the
  // strongest proof — and the rule cap keeps a run from proposing an arsenal.
  const rules = insights
    .map(proposeRuleFromInsight)
    .filter((proposal): proposal is LearningProposal => proposal !== null)
    .slice(0, MAX_LEARNING_RULES_PER_RUN);
  const memories = insights.slice(0, MAX_LEARNING_MEMORIES_PER_RUN).map(proposeMemoryFromInsight);
  const table = insights[0]?.table ?? firstTableFromSteps(steps);
  const skill = table ? proposeSkillFromRun(steps, table) : null;

  const proposals = [...rules, ...memories, ...(skill ? [skill] : [])];
  const byId = new Map<string, LearningProposal>();
  for (const proposal of proposals) {
    if (!byId.has(proposal.id)) byId.set(proposal.id, proposal);
  }
  return [...byId.values()].slice(0, LEARNING_MAX_PROPOSALS);
}

/** How a proposal reaches its store: the Tauri command invoker, injected so the
 * mapping is testable without a Tauri runtime. */
export type LearningInvoker = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** The workspace a proposal belongs to, used for the memory scope. */
export interface LearningScope {
  connectionId?: string | null;
  database?: string | null;
}

/**
 * Write an approved proposal. Runs only from a user click — the store the
 * proposal targets is the one the user chose, and nothing here runs SQL.
 */
export async function applyLearningProposal(
  proposal: LearningProposal,
  scope: LearningScope,
  invoke: LearningInvoker,
): Promise<string> {
  if (proposal.kind === "memory") {
    return String(
      await invoke("save_agent_memory", {
        name: proposal.memory.name,
        body: proposal.memory.body,
        description: proposal.memory.description,
        connectionId: scope.connectionId ?? null,
        database: scope.database ?? null,
      }),
    );
  }
  if (proposal.kind === "rule") {
    return String(
      await invoke("save_agent_rule", {
        name: proposal.rule.name,
        description: proposal.rule.description,
        event: proposal.rule.event,
        action: proposal.rule.action,
        pattern: proposal.rule.pattern,
        patternNot: null,
        scan: "skeleton",
      }),
    );
  }
  return String(
    await invoke("create_ai_skill", {
      name: proposal.skill.name,
      description: proposal.skill.description,
      body: proposal.skill.body,
    }),
  );
}
