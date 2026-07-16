import { describe, expect, it } from "vitest";
import { extractAgentRecordLinks } from "@/components/AISlidePanel/ai-agent-record-links";

describe("extractAgentRecordLinks", () => {
  it("creates a record link from a completed single-table read", () => {
    const links = extractAgentRecordLinks([{
      step: 2,
      action: "run_readonly_sql",
      message: "Read the matching user",
      status: "done",
      observation: JSON.stringify({
        query: "SELECT id, email FROM public.users WHERE email = '[REDACTED]'",
        sampleRows: [{ id: 42, email: "person@example.com" }],
      }),
    }]);

    expect(links).toEqual([{
      tableName: "public.users",
      rowKey: { id: 42 },
      label: "Open public.users record (id: 42)",
    }]);
  });

  it("does not link an ambiguous multi-table result", () => {
    const links = extractAgentRecordLinks([{
      step: 2,
      action: "run_readonly_sql",
      message: "Read joined data",
      status: "done",
      observation: JSON.stringify({
        query: "SELECT users.id FROM public.users JOIN public.teams ON teams.id = users.team_id",
        sampleRows: [{ id: 42 }],
      }),
    }]);

    expect(links).toEqual([]);
  });
});
