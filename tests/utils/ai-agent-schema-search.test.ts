import { describe, expect, it } from "vitest";
import {
  findAgentSchemaMatches,
  isAgentRecordLookupRequest,
  prioritizeSchemaScanCandidates,
} from "@/components/AISlidePanel/ai-agent-schema-search";
import type { ColumnDetail } from "@/types";

function column(name: string, dataType = "text"): ColumnDetail {
  return {
    name,
    data_type: dataType,
    is_nullable: true,
    is_primary_key: name === "id",
  };
}

describe("findAgentSchemaMatches", () => {
  it("recognizes concrete record lookups without treating greetings as data requests", () => {
    expect(isAgentRecordLookupRequest("Kiểm tra user có email truongminh0949@gmail.com")).toBe(true);
    expect(isAgentRecordLookupRequest("Tìm sự việc liên quan IP 127.0.0.1")).toBe(true);
    expect(isAgentRecordLookupRequest("xin chào")).toBe(false);
  });

  it("finds an email column across unrelated table names", () => {
    const matches = findAgentSchemaMatches("Find truongminh0949@gmail.com", [
      { identifier: "public.user_ip_addresses", columns: [column("id", "bigint"), column("ip_address")] },
      { identifier: "public.users", columns: [column("id", "bigint"), column("email"), column("display_name")] },
    ]);

    expect(matches[0]).toMatchObject({
      table: "public.users",
      columns: [{ name: "email", dataType: "text" }],
    });
  });

  it("returns no false matches when the requested field is absent", () => {
    expect(findAgentSchemaMatches("email", [
      { identifier: "public.audit_logs", columns: [column("id"), column("event_type")] },
    ])).toEqual([]);
  });
});

describe("prioritizeSchemaScanCandidates", () => {
  it("returns the catalog untouched when it already fits the scan budget", () => {
    const identifiers = ["public.users", "public.orders"];
    expect(prioritizeSchemaScanCandidates(identifiers, "email address", 10)).toEqual(identifiers);
  });

  it("puts name matches first and caps the scan on large catalogs", () => {
    const identifiers = [
      "public.audit_logs",
      "public.user_emails",
      "public.sessions",
      "public.email_domains",
      "public.metrics",
    ];
    const prioritized = prioritizeSchemaScanCandidates(identifiers, "email", 2);

    expect(prioritized).toHaveLength(2);
    expect(prioritized).toContain("public.user_emails");
    expect(prioritized).toContain("public.email_domains");
  });

  it("falls back to the first tables in catalog order when nothing matches", () => {
    const identifiers = ["a_logs", "b_sessions", "c_metrics"];
    expect(prioritizeSchemaScanCandidates(identifiers, "zzz_unrelated", 2)).toEqual([
      "a_logs",
      "b_sessions",
    ]);
  });
});
