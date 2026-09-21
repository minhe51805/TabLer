import { agentSqlToolBlockedMessage } from "../ai-agent-engine-gates";
import { redactAgentSqlLiterals } from "../ai-agent-grounding";
import { agentToolError, analyzeAgentSqlForAgent } from "../agent-tool-executor-helpers";
import { stringifyAgentObservation, type AgentToolModule } from "./shared";

export const tool: AgentToolModule = {
  name: "check_sql",
  handler: async (ctx, args, frame) => {
    if (ctx.toolAvailability && !ctx.toolAvailability.sqlRead) {
      return agentSqlToolBlockedMessage("check_sql", ctx.toolAvailability);
    }
    const sql = typeof args?.sql === "string" ? args.sql.trim() : "";
    if (!sql) {
      return agentToolError("check_sql requires args.sql.", {
        hint: "Send args.sql as the single statement to validate.",
      });
    }
    const analysis = analyzeAgentSqlForAgent(
      sql,
      ctx.availableSchemaTables,
      ctx.inspectedAgentTables,
    );
    const unboundedSelect =
      analysis.ok &&
      /^(SELECT|WITH)\b/i.test(sql) &&
      !/\bLIMIT\s+\d/i.test(sql) &&
      !/^EXPLAIN\b/i.test(sql);
    return stringifyAgentObservation(frame, {
      ok: analysis.ok && !unboundedSelect,
      sql: redactAgentSqlLiterals(sql),
      issues: analysis.ok ? [] : [analysis.error],
      ...(unboundedSelect
        ? {
            notes: [
              "The SELECT has no LIMIT - add one before finishing so it can never become a full-table pull.",
            ],
          }
        : {}),
      note:
        analysis.ok && !unboundedSelect
          ? "Pre-flight passed. You may now finish with this SQL."
          : "Fix every issue (or re-check corrected SQL) before calling finish.",
    });
  },
};
