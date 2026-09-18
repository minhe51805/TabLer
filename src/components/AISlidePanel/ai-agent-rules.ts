import type { AISqlConfirmationRequirement } from "./ai-execution-policy";

/**
 * The guardrail layer the Rust rules engine (`agent_rules.rs`) hands back for
 * one candidate statement. `decision` is the only field a caller must switch
 * on; `message` is what the model is fed back as the tool result and what the
 * human sees in the trace.
 */
export type AgentRuleAction = "warn" | "require_approval" | "block";
export type AgentRuleDecision = "allow" | AgentRuleAction;
export type AgentRuleOrigin = "builtin" | "global" | "workspace";
export type AgentRuleSqlEvent = "read" | "write" | "unknown";

export interface AgentRuleMatch {
  name: string;
  description: string;
  action: AgentRuleAction;
  origin: AgentRuleOrigin;
}

export interface AgentRuleVerdict {
  decision: AgentRuleDecision;
  action: AgentRuleAction;
  event: AgentRuleSqlEvent;
  message: string;
  matched_rules: AgentRuleMatch[];
}

export interface AgentRuleLoadError {
  path: string;
  reason: string;
}

export interface AgentRuleLoadReport {
  loaded: number;
  skipped: number;
  errors: AgentRuleLoadError[];
}

export interface AgentRuleEvaluation {
  verdict: AgentRuleVerdict;
  report: AgentRuleLoadReport;
}

/** Strictest-first ordering, mirroring `RuleAction`'s `Ord` on the Rust side. */
const ACTION_RANK: Record<AgentRuleAction, number> = {
  warn: 1,
  require_approval: 2,
  block: 3,
};

/** The verdict a statement gets when nothing objected — and the fail-open base. */
export function allowedRuleVerdict(event: AgentRuleSqlEvent = "unknown"): AgentRuleVerdict {
  return { decision: "allow", action: "warn", event, message: "", matched_rules: [] };
}

export function isRuleAction(value: unknown): value is AgentRuleAction {
  return value === "warn" || value === "require_approval" || value === "block";
}

/**
 * Fold several per-statement verdicts into one run-level verdict.
 *
 * A script is only as safe as its most dangerous statement, so the fold always
 * takes the strictest action — never the first or the last. Matching rules are
 * merged and de-duplicated by name so a rule that fires on two statements is
 * reported once, and the messages are concatenated in the same order the
 * verdicts arrived so the reason reads like the script.
 */
export function foldAgentRuleVerdicts(verdicts: AgentRuleVerdict[]): AgentRuleVerdict {
  const meaningful = verdicts.filter((verdict) => !isRuleAllowed(verdict));
  if (meaningful.length === 0) {
    return allowedRuleVerdict(verdicts[0]?.event ?? "unknown");
  }

  const action = meaningful.reduce<AgentRuleAction>(
    (strictest, verdict) =>
      ACTION_RANK[verdict.action] > ACTION_RANK[strictest] ? verdict.action : strictest,
    "warn",
  );

  const byName = new Map<string, AgentRuleMatch>();
  const messages: string[] = [];
  for (const verdict of meaningful) {
    if (verdict.message) messages.push(verdict.message);
    for (const match of verdict.matched_rules) {
      if (!byName.has(match.name)) byName.set(match.name, match);
    }
  }

  // The strictest statement class wins too: a read that writes is a write.
  const event: AgentRuleSqlEvent = meaningful.some((verdict) => verdict.event === "write")
    ? "write"
    : (meaningful[0].event ?? "unknown");

  return {
    decision: action,
    action,
    event,
    message: messages.join(" "),
    matched_rules: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * True when no rule objected. A missing verdict counts as allowed.
 *
 * The test is `decision`, NOT "has no matched rules". A verdict can legitimately
 * carry a non-allow decision with an empty `matched_rules` list: that is exactly
 * what `ruleVerdictFromEngineError` returns for a mutating statement whose
 * guardrail evaluation failed. Deciding by `matched_rules.length` read that
 * escalation as "allowed" and silently ran the unvetted write — the precise
 * failure the escalation exists to prevent.
 */
export function isRuleAllowed(verdict: AgentRuleVerdict | null | undefined): boolean {
  if (!verdict) return true;
  return verdict.decision === "allow";
}

export function isRunBlockedByRules(verdict: AgentRuleVerdict | null | undefined): boolean {
  return !isRuleAllowed(verdict) && verdict!.action === "block";
}

export function rulesRequireApproval(verdict: AgentRuleVerdict | null | undefined): boolean {
  return !isRuleAllowed(verdict) && verdict!.action === "require_approval";
}

/**
 * The dialog tier a rule verdict demands, so a `require_approval` rule can ride
 * the existing confirmation flow instead of inventing a second one. `null`
 * means "the rules add no requirement" — the caller keeps whatever the
 * statement analysis already decided.
 */
export function ruleVerdictToRequirement(
  verdict: AgentRuleVerdict | null | undefined,
): AISqlConfirmationRequirement {
  if (rulesRequireApproval(verdict)) return "mutation";
  return null;
}

/**
 * One line naming every rule that fired, for the trace and for the model.
 * Naming the rule matters: "blocked" alone teaches nothing, while
 * "[no-delete-without-where] this DELETE has no WHERE" is actionable.
 */
export function describeRuleVerdict(verdict: AgentRuleVerdict | null | undefined): string {
  if (isRuleAllowed(verdict)) return "";
  const names = verdict!.matched_rules.map((match) => match.name).join(", ");
  return verdict!.message ? `${names}: ${verdict!.message}` : names;
}

/**
 * The refusal handed back to the model when a `block` rule stops a statement.
 * It is deliberately a *tool result* rather than a thrown UI error: the model
 * must be told why so it can rewrite the statement, which is the whole point of
 * a guardrail (identical to hookify feeding `exit 2` + stderr back).
 */
export function formatRuleBlockMessage(verdict: AgentRuleVerdict): string {
  const detail = describeRuleVerdict(verdict) || "a guardrail rule";
  return `Blocked by the workspace guardrail rules — ${detail}. Rewrite the statement to satisfy the rule, or ask the user to disable it, before retrying.`;
}

/**
 * Fold a rules-engine failure into a verdict.
 *
 * Failure policy, ported from hookify's `pretooluse.py`: a broken rule must
 * never break a session, so an engine error fails **open** for reads. But a
 * mutating statement must not slip past a guardrail that simply failed to load
 * either, so a write is escalated to `require_approval` — a human gate rather
 * than a silent pass. That is the honest middle: closed enough to be safe,
 * open enough that one bad file cannot make the app unusable.
 */
export function ruleVerdictFromEngineError(error: unknown, isMutating: boolean): AgentRuleVerdict {
  if (!isMutating) return allowedRuleVerdict("read");
  const reason = error instanceof Error ? error.message : String(error);
  return {
    decision: "require_approval",
    action: "require_approval",
    event: "write",
    message: `[guardrail-engine-error] the rules engine could not evaluate this write (${reason}); it needs explicit approval.`,
    matched_rules: [],
  };
}

/** Tauri command payload — kept separate so tests never need a Tauri runtime. */
export interface RuleEvaluationRequest {
  statement: string;
  workspaceDir?: string | null;
  /** Force a guardrail phase (`pre_read` / `pre_write`) instead of deriving it. */
  event?: "pre_read" | "pre_write" | "any";
}

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Evaluate one statement against the armed guardrail pack.
 *
 * The engine is asynchronous and lives in Rust; the gate helpers above stay
 * pure so the decision table is unit-testable without a Tauri runtime.
 */
export async function evaluateAgentRules(
  { statement, workspaceDir, event }: RuleEvaluationRequest,
  invoke: InvokeFn,
): Promise<AgentRuleEvaluation> {
  return invoke<AgentRuleEvaluation>("evaluate_agent_rules", {
    workspaceDir: workspaceDir ?? null,
    statement,
    event: event ?? null,
  });
}

/**
 * Evaluate a whole run and fold it into one verdict.
 *
 * Fails open per the policy above instead of throwing: the caller must be able
 * to keep running reads even when the rules directory is damaged. Pass
 * `isMutating` so a failed evaluation of a write is escalated rather than
 * waved through.
 */
export async function evaluateRunAgainstRules(
  statements: string[],
  options: {
    isMutating: boolean;
    workspaceDir?: string | null;
    event?: "pre_read" | "pre_write" | "any";
    invoke: InvokeFn;
  },
): Promise<AgentRuleVerdict> {
  const verdicts: AgentRuleVerdict[] = [];
  for (const statement of statements) {
    if (!statement.trim()) continue;
    try {
      const evaluation = await evaluateAgentRules(
        { statement, workspaceDir: options.workspaceDir, event: options.event },
        options.invoke,
      );
      verdicts.push(evaluation.verdict);
    } catch (error) {
      verdicts.push(ruleVerdictFromEngineError(error, options.isMutating));
    }
  }
  return foldAgentRuleVerdicts(verdicts);
}

/** Rules that failed to load, so the UI can say the guardrail is degraded. */
export function describeRuleLoadErrors(report: AgentRuleLoadReport | null | undefined): string[] {
  if (!report?.errors?.length) return [];
  return report.errors.map((error) => `${error.path}: ${error.reason}`);
}
