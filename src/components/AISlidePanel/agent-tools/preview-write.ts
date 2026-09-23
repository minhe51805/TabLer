import {
  formatExecutionError,
  isHighRiskStatement,
  isMutatingStatement,
  isSessionSwitchStatement,
  normalizeStatementForGuard,
} from "../../SQLEditor/SQLEditorUtils";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "../ai-agent-action-requestor";
import { agentSqlToolBlockedMessage } from "../ai-agent-engine-gates";
import {
  describeRuleVerdict,
  formatRuleBlockMessage,
  isRunBlockedByRules,
  ruleVerdictFromEngineError,
  type AgentRuleVerdict,
} from "../ai-agent-rules";
import {
  agentSqlErrorHint,
  agentToolError,
  isRetryableAgentToolError,
} from "../agent-tool-executor-helpers";
import { classifySqlSafety } from "../../../utils/sql-safety";
import { stringifyAgentObservation, type AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "preview_write",
  handler: async (ctx, args, frame) => {
    if (ctx.toolAvailability && !ctx.toolAvailability.previewWrite) {
      return agentSqlToolBlockedMessage("preview_write", ctx.toolAvailability);
    }
    const requested = Array.isArray(args?.statements) ? args.statements : [];
    const statements = requested
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    if (statements.length === 0) {
      return agentToolError("preview_write requires a non-empty args.statements array.", {
        hint: "Send args.statements like [\"UPDATE orders SET status = 'x' WHERE id = 1\"].",
      });
    }

    // Safety rails: at least one real change, no session switching,
    // and explicit user consent before touching live rows.
    const frontendMutating = (statement: string) =>
      isMutatingStatement(statement) || isHighRiskStatement(statement);
    // The backend classifier is authoritative for what counts as a write —
    // `EXPLAIN ANALYZE <write>` executes its inner statement and must take
    // the preview path (rolled-back transaction) instead of being refused.
    let backendNonReadonly = new Set<string>();
    try {
      const decision = await classifySqlSafety(statements.join(";\n"), ctx.dbType ?? null);
      backendNonReadonly = new Set(
        decision.statements
          .filter((entry) => !entry.readOnly)
          .map((entry) => normalizeStatementForGuard(entry.sql)),
      );
    } catch {
      // Fail-open: the frontend keyword guard still applies below.
    }
    const mutatingCount = statements.filter(
      (statement) =>
        frontendMutating(statement) ||
        backendNonReadonly.has(normalizeStatementForGuard(statement)),
    ).length;
    if (mutatingCount === 0) {
      return agentToolError(
        "preview_write requires at least one INSERT/UPDATE/DELETE/ALTER/CREATE statement. Use run_readonly_sql for reads.",
      );
    }
    for (const statement of statements) {
      if (isSessionSwitchStatement(statement)) {
        return "Tool blocked: session-switch statements are not allowed in write previews.";
      }
    }

    // Guardrail rules (P6.1): user-authored rules in `<workspace>/rules` and
    // the seeded built-in pack get a say before anything is previewed. A
    // `block` rule refuses the call and the reason travels back to the model
    // as the tool result, so it can rewrite the statement instead of
    // guessing. An engine failure is escalated by the helper rather than
    // silently passed, because this is the write path.
    // Filled by the guardrail check below: a `warn` rule's reason must reach the
    // model rather than being discarded with the verdict.
    let ruleCaution = "";
    if (ctx.evaluateGuardrailRules) {
      let verdict: AgentRuleVerdict;
      try {
        verdict = await ctx.evaluateGuardrailRules(statements, { isMutating: true });
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        verdict = ruleVerdictFromEngineError(errorValue, true);
      }
      if (isRunBlockedByRules(verdict)) {
        ctx.publishAgentProgress({
          action: "preview_write",
          message: `Guardrail rule refused the write preview (${verdict.matched_rules
            .map((match) => match.name)
            .join(", ")}).`,
        });
        return `Tool blocked: ${formatRuleBlockMessage(verdict)}`;
      }
      // A `warn` / `require_approval` rule is not a refusal, but it must not be
      // dropped either: the contract for `warn` is "surface it to the model as a
      // caution". A discarded verdict is exactly the failure mode this subsystem
      // exists to prevent, so the notice travels back with the preview.
      ruleCaution = describeRuleVerdict(verdict);
    }

    if (ctx.requestDataReadConsent) {
      const approved = await ctx.requestDataReadConsent();
      if (!approved) {
        return "Tool blocked: The user did not grant permission to run the write preview for this request.";
      }
    }
    // A superseded run must not hit the database at all — check before the
    // checkpoint + preview calls, not only after them.
    if (ctx.requestId !== ctx.requestIdRef.current) {
      throw new Error(AI_REQUEST_REPLACED_MESSAGE);
    }

    // Pre-write safety net: snapshot the database under the
    // "agent-pre-write" label before the first mutating preview of the
    // run. Best-effort — a failure warns inside the observation but never
    // blocks the preview itself.
    const preWriteNote = await ctx.ensurePreWriteCheckpoint();

    try {
      const preview = await ctx.previewWriteTransaction(ctx.connectionId!, statements);
      for (const statement of statements) {
        // Record every statement the mutating gate counted (frontend keyword
        // OR backend classifier) so edit_query_sql's preview gate accepts
        // exactly what was previewed — e.g. EXPLAIN ANALYZE <write>.
        if (
          frontendMutating(statement) ||
          backendNonReadonly.has(normalizeStatementForGuard(statement))
        ) {
          ctx.previewedMutatingStatements.add(normalizeStatementForGuard(statement));
        }
      }
      const summary = preview.results.map((result, index) => ({
        statement: statements[index] ?? `statement ${index + 1}`,
        affectedRows: result.affected_rows,
        returnedRows: result.rows.length,
        truncated: result.truncated || undefined,
      }));
      return stringifyAgentObservation(frame, {
        rolledBack: true,
        persisted: false,
        note: "Executed inside one transaction and ROLLED BACK. Nothing was saved. Report these effects as a PREVIEW and direct the user to apply the final SQL through the approval flow.",
        statementCount: statements.length,
        results: summary,
        ...(ruleCaution ? { guardrailRules: ruleCaution } : {}),
        preWriteCheckpoint: preWriteNote,
      });
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      return agentToolError(formatExecutionError(errorValue), {
        hint: agentSqlErrorHint(errorValue),
        retryable: isRetryableAgentToolError(errorValue),
      });
    }
  },
};
