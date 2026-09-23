import {
  formatExecutionError,
  isHighRiskStatement,
  isMutatingStatement,
  normalizeStatementForGuard,
} from "../../SQLEditor/SQLEditorUtils";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "../ai-agent-action-requestor";
import { summarizeAgentExplainPlanStructured } from "../ai-agent-grounding";
import { classifyAgentExplainableStatement } from "../ai-agent-tools";
import { agentToolError } from "../agent-tool-executor-helpers";
import { classifySqlSafety } from "../../../utils/sql-safety";
import type { AiProposalExplainResult } from "../../../stores/event-center";
import { EventCenter } from "../../../stores/event-center";
import { useUIStore } from "../../../stores/uiStore";
import type { AgentToolModule } from "./shared";

// Non-SQL engines: mongo shell write methods and Redis write commands must
// never auto-run — `isMutatingStatement` only understands SQL keywords.
const DOCUMENT_WRITE_METHOD =
  /\b(?:insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|replaceOne|drop|createCollection|renameCollection|dropDatabase|bulkWrite|findOneAndDelete|findOneAndReplace|findOneAndUpdate)\s*\(/i;
const KV_WRITE_COMMAND =
  /^\s*(?:SET|DEL|UNLINK|FLUSHDB|FLUSHALL|EXPIRE|RENAME|MOVE|COPY|SWAPDB|MSET|SETRANGE|APPEND|INCR|DECR|HSET|HDEL|LPUSH|RPUSH|LPOP|RPOP|SADD|SREM|ZADD|ZREM)\b/i;
const DOCUMENT_READ_METHOD =
  /\b(?:find|findOne|count|countDocuments|estimatedDocumentCount|aggregate|distinct|explain|listIndexes|stats|getIndexes)\s*\(/i;
const KV_READ_COMMAND =
  /^\s*(?:GET|MGET|EXISTS|TYPE|TTL|PTTL|STRLEN|GETRANGE|HGET|HGETALL|HLEN|HKEYS|HVALS|HMGET|HEXISTS|LRANGE|LLEN|LINDEX|SMEMBERS|SCARD|SISMEMBER|ZRANGE|ZCARD|ZSCORE|ZRANK|KEYS|SCAN|HSCAN|SSCAN|ZSCAN|INFO|DBSIZE|PING|TIME|RANDOMKEY|OBJECT|XINFO|XRANGE|XLEN|XREAD|JSON\.GET|JSON\.OBJKEYS|JSON\.OBJLEN|JSON\.TYPE|JSON\.ARRLEN|JSON\.ARRINDEX|FT\.SEARCH|FT\.INFO|FT\.EXPLAIN)\b/i;

/** Auto-run is only safe for a statement we can positively classify as a
    read on a non-SQL engine. Anything unrecognized stays manual. */
export function nonSqlStatementIsSafeAutoRun(sql: string, queryModel: string | undefined) {
  if (queryModel === "document") {
    return DOCUMENT_READ_METHOD.test(sql) && !DOCUMENT_WRITE_METHOD.test(sql);
  }
  if (queryModel === "kv") {
    return KV_READ_COMMAND.test(sql) && !KV_WRITE_COMMAND.test(sql);
  }
  // cql/search/unknown: no reliable read classifier — never auto-run.
  return false;
}

export const tool: AgentToolModule = {
  name: "edit_query_sql",
  handler: async (ctx, args) => {
    const rawTabId = typeof args?.tabId === "string" ? args.tabId.trim() : "";
    const sql = typeof args?.sql === "string" ? args.sql.trim() : "";
    const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
    // Weak providers frequently send booleans as strings ("true"). The
    // schema says boolean, but rejecting the call over the type would just
    // push the model to fabricate a PASS — coerce the common shapes instead.
    const rawCreateIfMissing: unknown = args?.createIfMissing;
    const createIfMissing =
      rawCreateIfMissing === true || rawCreateIfMissing === "true" || rawCreateIfMissing === 1;
    if (!sql) {
      return agentToolError("edit_query_sql requires args.sql.", {
        hint: "Send args.sql as the full proposed statement plus args.reason explaining the change.",
      });
    }
    if (sql.includes("…[TRUNCATED")) {
      return agentToolError(
        "do not echo the truncation marker from the context. Propose only content you have actually seen; explain anything outside your view in args.reason.",
      );
    }
    // The tab must exist, be a query tab, and belong to THIS run's
    // connection — the agent must not reach into another connection's
    // editors.
    const { tabs } = useUIStore.getState();
    const target = rawTabId ? tabs.find((tab) => tab.id === rawTabId) : undefined;
    if (rawTabId && (!target || target.type !== "query")) {
      return agentToolError(
        "edit_query_sql needs the exact tabId of an open query tab (see the Query tabs list in the context).",
        {
          hint: "Copy the tabId verbatim from the Query tabs list, or omit it and set args.createIfMissing: true.",
        },
      );
    }
    if (target && target.connectionId !== ctx.connectionId) {
      return agentToolError(
        `query tab "${target.title}" belongs to another connection — edit_query_sql cannot reach across connections.`,
      );
    }
    // Smoke-test gate: a mutating proposal that was never previewed in
    // THIS run is rejected. Reads go through the sandbox naturally.
    const frontendMutating = isMutatingStatement(sql) || isHighRiskStatement(sql);
    const queryModel = ctx.toolAvailability?.queryModel;
    // CQL shares the SQL keyword surface, so the SQL mutating guard applies.
    const sqlKeywordEngine = !queryModel || queryModel === "sql" || queryModel === "cql";
    // The frontend keyword guard cannot see through `EXPLAIN ANALYZE <write>`
    // or dialect constructs — the backend classifier is authoritative:
    // anything it does not call read-only is treated as mutating (preview
    // gate + checkpoint + no auto-run). A classifier failure keeps the
    // frontend verdict; the proposal still lands in a reviewable tab.
    let mutating = frontendMutating;
    if (sqlKeywordEngine && !frontendMutating) {
      try {
        const decision = await classifySqlSafety(sql, ctx.dbType ?? null);
        if (!decision.readOnly) mutating = true;
      } catch {
        // Fail-open: the review card still requires a human click to run.
      }
    }
    const autoRun = sqlKeywordEngine ? !mutating : nonSqlStatementIsSafeAutoRun(sql, queryModel);
    if (mutating && !ctx.previewedMutatingStatements.has(normalizeStatementForGuard(sql))) {
      return agentToolError(
        "this proposal contains mutating SQL that was not previewed in this run. Call preview_write with the exact statement first, then re-issue edit_query_sql.",
        {
          hint: "preview_write runs the statement in a rolled-back transaction — it is safe and required once per mutating statement.",
        },
      );
    }
    // Pre-write safety net: a mutating proposal that passed the preview
    // gate snapshots the database under "agent-pre-write" before the
    // proposal is emitted. Best-effort — a failure warns, never blocks.
    const preWriteNote = mutating ? await ctx.ensurePreWriteCheckpoint() : "";
    // Dry-run EXPLAIN: a mutating proposal carries its plan (or its
    // syntax error) on the review card so the user sees it BEFORE
    // accepting. The statement is planned, never executed — the backend
    // wraps it as `EXPLAIN <stmt>` server-side. DML is explainable on
    // every engine, so a failure there means broken SQL; DDL is
    // best-effort and a failure only means the engine declined to plan it.
    let proposalExplain: AiProposalExplainResult | undefined;
    if (mutating && ctx.explainStatement && ctx.connectionId) {
      const explainable = classifyAgentExplainableStatement(sql);
      if (explainable !== "none") {
        try {
          const plan = await ctx.explainStatement(ctx.connectionId, sql);
          const summary = summarizeAgentExplainPlanStructured(plan, ctx.dbType);
          proposalExplain = { status: "ok", summary: summary || undefined };
        } catch (errorValue) {
          if (isSupersededAIRequestError(errorValue)) throw errorValue;
          proposalExplain = {
            status: explainable === "dml" ? "error" : "unsupported",
            error: formatExecutionError(errorValue),
          };
        }
        if (ctx.requestId !== ctx.requestIdRef.current) {
          throw new Error(AI_REQUEST_REPLACED_MESSAGE);
        }
      }
    }
    if (!target) {
      if (!createIfMissing) {
        return agentToolError(
          "no open query tab matched. Pass the exact tabId of an open query tab, or set args.createIfMissing: true to open a new AI Query tab with this SQL.",
        );
      }
      const title = (reason || "AI query proposal").slice(0, 60);
      const created = ctx.openQueryTab?.({ sql, title, autoRun });
      if (!created) {
        return agentToolError("could not open a new AI Query tab (no active connection?).", {
          retryable: true,
        });
      }
      const explainNote =
        proposalExplain?.status === "error"
          ? ` Warning: the EXPLAIN dry-run failed — the statement is likely broken: ${proposalExplain.error}`
          : proposalExplain?.status === "unsupported"
            ? ` Note: this engine could not EXPLAIN the statement (${proposalExplain.error}).`
            : "";
      return (
        [
          `No query tab was open — created a new AI Query tab "${title}" pre-filled with the proposed SQL.`,
          autoRun
            ? "It auto-runs the read-only statement."
            : "It is NOT auto-run: review the tab and press Run (Safe Mode will confirm).",
        ].join(" ") +
        explainNote +
        (preWriteNote ? ` ${preWriteNote}` : "")
      );
    }

    const reasonLine = reason || "Corrected SQL proposal from the agent.";
    // Proposal only: the tab renders Accept/Reject. The agent never
    // writes editor content directly and never executes the proposal.
    EventCenter.emit("ai-edit-query-sql", {
      tabId: rawTabId,
      sql,
      reason: reasonLine,
      ...(proposalExplain ? { explain: proposalExplain } : {}),
    });
    return [
      `Proposal sent to query tab "${target.title}" — waiting for the user to accept or reject it in the tab.`,
      `Fix: ${reasonLine}`,
      mutating
        ? "Reminder: on accept the tab content changes only; the user still runs it (an auto-checkpoint is captured first)."
        : "On accept the tab content changes only; the user still runs it.",
      proposalExplain?.status === "error"
        ? `EXPLAIN dry-run failed (shown on the card): ${proposalExplain.error}`
        : proposalExplain?.status === "unsupported"
          ? `This engine could not EXPLAIN the statement (shown on the card): ${proposalExplain.error}`
          : proposalExplain?.status === "ok"
            ? "EXPLAIN dry-run succeeded — the plan is shown on the proposal card."
            : "",
      preWriteNote || "",
    ]
      .filter(Boolean)
      .join("\n");
  },
};
