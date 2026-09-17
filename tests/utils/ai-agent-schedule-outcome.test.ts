import { describe, expect, it } from "vitest";

import {
  MAX_AGENT_RUN_ERROR_CHARS,
  MAX_AGENT_RUN_SUMMARY_CHARS,
  buildAgentRunSummary,
  clampReportText,
  describeAgentRunFailure,
  describeFinishedAgentRun,
  formatBlockedToolNote,
} from "@/components/AISlidePanel/ai-agent-schedule-outcome";
import { AI_REQUEST_REPLACED_MESSAGE } from "@/components/AISlidePanel/ai-agent-action-requestor";
import type { AIAgentToolName } from "@/components/AISlidePanel/tool-schema/constants";

describe("agent schedule run report", () => {
  it("turns a multi-line report into one clamped line", () => {
    expect(buildAgentRunSummary({ response: "  Line one.\n\n  Line two.  " })).toBe(
      "Line one. Line two.",
    );
  });

  it("caps the report at the same length the backend persists", () => {
    const summary = buildAgentRunSummary({
      response: "x".repeat(MAX_AGENT_RUN_SUMMARY_CHARS + 50),
    });
    expect(summary).toHaveLength(MAX_AGENT_RUN_SUMMARY_CHARS);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("names the write tools an unattended run was refused, once each", () => {
    const summary = buildAgentRunSummary({
      response: "Checked the orders table.",
      blockedTools: ["preview_write", "preview_write", "ask_user"],
    });
    expect(summary).toContain(
      "[read-only] refused 2 blocked tool call(s): ask_user, preview_write",
    );
    expect(summary.endsWith("Checked the orders table.")).toBe(true);
  });

  it("summarizes a long refusal list instead of listing every name", () => {
    const tools: AIAgentToolName[] = [
      "ask_user",
      "preview_write",
      "propose_seed_data",
      "edit_query_sql",
      "remember_term",
      "save_memory",
      "delete_memory",
    ];
    const note = formatBlockedToolNote(tools);
    expect(note).toContain("refused 7 blocked tool call(s)");
    expect(note).toContain("(+1 more)");
  });

  it("still records the refusal when the run reported nothing else", () => {
    expect(buildAgentRunSummary({ response: "   ", blockedTools: ["preview_write"] })).toBe(
      "[read-only] refused 1 blocked tool call(s): preview_write",
    );
    expect(formatBlockedToolNote([])).toBeNull();
    expect(formatBlockedToolNote(undefined)).toBeNull();
  });

  it("keeps an empty report empty instead of inventing one", () => {
    expect(buildAgentRunSummary({ response: "" })).toBe("");
    expect(clampReportText("   \n ", 10)).toBe("");
  });
});

describe("finished unattended run outcome", () => {
  it("reports a clean run as ok with its own findings", () => {
    expect(describeFinishedAgentRun({ response: "3 orders are stuck." })).toEqual({
      status: "ok",
      summary: "3 orders are stuck.",
    });
  });

  it("reports a run that was refused a tool as needing a human", () => {
    const report = describeFinishedAgentRun({
      response: "I could not change the data.",
      blockedTools: ["preview_write", "preview_write"],
    });
    expect(report.status).toBe("needs_human");
    expect(report.summary).toContain("refused 1 blocked tool call(s): preview_write");
  });

  it("never reports ok with an empty summary as a result", () => {
    expect(describeFinishedAgentRun({ response: "   " })).toEqual({ status: "ok", summary: null });
  });
});

describe("agent schedule run failure", () => {
  it("reports a superseded run as interrupted, not as a provider failure", () => {
    const message = describeAgentRunFailure(new Error(AI_REQUEST_REPLACED_MESSAGE));
    expect(message).toContain("replaced by another request");
  });

  it("keeps the provider's own message for a real failure", () => {
    expect(describeAgentRunFailure(new Error("Request failed: 500"))).toBe("Request failed: 500");
    expect(describeAgentRunFailure("socket closed")).toBe("socket closed");
  });

  it("never reports an empty or oversized error", () => {
    expect(describeAgentRunFailure(new Error("   "))).toBe(
      "The scheduled agent task failed without an error message.",
    );
    const long = describeAgentRunFailure(new Error("e".repeat(MAX_AGENT_RUN_ERROR_CHARS + 80)));
    expect(long).toHaveLength(MAX_AGENT_RUN_ERROR_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });
});
