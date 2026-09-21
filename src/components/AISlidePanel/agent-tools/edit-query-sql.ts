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
import type { AiProposalExplainResult } from "../../../stores/event-center";
import { EventCenter } from "../../../stores/event-center";
import { useUIStore } from "../../../stores/uiStore";
import type { AgentToolModule } from "./shared";

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
    const mutating = isMutatingStatement(sql) || isHighRiskStatement(sql);
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
      const created = ctx.openQueryTab?.({ sql, title, autoRun: !mutating });
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
          mutating
            ? "It is NOT auto-run: review the tab and press Run (Safe Mode will confirm)."
            : "It auto-runs the read-only statement.",
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
