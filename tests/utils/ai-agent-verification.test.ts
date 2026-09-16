import { describe, expect, it } from "vitest";
import {
  collectObservedNumbers,
  extractClaimedNumbers,
  nearestKnownIdentifier,
  normalizeClaimedNumber,
  verifyAgentResponseAgainstEvidence,
} from "@/components/AISlidePanel/ai-agent-verification";
import type { AgentTraceStep } from "@/components/AISlidePanel/ai-agent-context";

function step(observation: string): AgentTraceStep {
  return { step: 1, action: "run_readonly_sql", message: "", observation };
}

describe("normalizeClaimedNumber", () => {
  it("strips thousand separators in common formats", () => {
    expect(normalizeClaimedNumber("1.234")).toBe(1234);
    expect(normalizeClaimedNumber("1,234")).toBe(1234);
    expect(normalizeClaimedNumber("12 500")).toBe(12500);
    expect(normalizeClaimedNumber("42")).toBe(42);
  });
});

describe("verifyAgentResponseAgainstEvidence", () => {
  it("accepts answers whose figures were observed by tools", () => {
    const verification = verifyAgentResponseAgainstEvidence(
      "Tổng cộng có 1.234 người dùng, trong đó 300 tài khoản bị khóa.",
      [
        step('{ "rowCount": 1234, "results": [{ "locked": 300 }] }'),
      ],
    );
    expect(verification.ok).toBe(true);
    expect(verification.unsupported).toEqual([]);
  });

  it("flags statistics that no observation ever witnessed", () => {
    const verification = verifyAgentResponseAgainstEvidence(
      "Khoảng 45.000 user hoạt động mỗi ngày và doanh thu 2.5 tỷ.",
      [step('{ "rowCount": 120 }')],
    );
    expect(verification.ok).toBe(false);
    expect(verification.unsupported).toContain(45000);
  });

  it("tolerates small ordinal numbers and a single unsupported figure", () => {
    expect(extractClaimedNumbers("Bước 3 liệt kê 4 nhóm")).toEqual([]);

    const verification = verifyAgentResponseAgainstEvidence(
      "Thấy 7 bảng và khoảng 9800 bản ghi.",
      [step('{ "tablesScanned": 7, "rowCount": 120 }')],
    );
    expect(verification.ok).toBe(true);
  });

  it("passes through empty responses", () => {
    expect(verifyAgentResponseAgainstEvidence(undefined, [])).toEqual({ ok: true, unsupported: [], unsupportedIdentifiers: [] });
  });

  it("collects numbers from structured observation keys", () => {
    const observed = collectObservedNumbers([
      step('{ "affectedRows": 42 }'),
      step('"value": 1337'),
    ]);
    expect(observed.has(42)).toBe(true);
    expect(observed.has(1337)).toBe(true);
  });
});

describe("identifier verification", () => {
  it("flags two or more table/column names no schema or observation witnessed", () => {
    const verification = verifyAgentResponseAgainstEvidence(
      "Kết quả lấy từ bảng `phantom_users` và cột `ghost_total`.",
      [step('{ "rowCount": 10 }')],
    );
    expect(verification.ok).toBe(false);
    const cited = verification.unsupportedIdentifiers.map((item) => item.cited);
    expect(cited).toContain("phantom_users");
    expect(cited).toContain("ghost_total");
  });

  it("accepts names present in the live schema even when no tool touched them", () => {
    const verification = verifyAgentResponseAgainstEvidence(
      "Bảng `customers` và `orders` đều có dữ liệu.",
      [step('{ "rowCount": 10 }')],
      ["public.customers", "public.orders"],
    );
    expect(verification.ok).toBe(true);
    expect(verification.unsupportedIdentifiers).toEqual([]);
  });

  it("accepts names the trace actually observed", () => {
    const verification = verifyAgentResponseAgainstEvidence(
      "Bảng `invoices` và cột `amount` có sẵn.",
      [step('[{ "name": "invoices" }, { "column": "amount" }]')],
    );
    expect(verification.ok).toBe(true);
  });

  it("attaches a did-you-mean suggestion for a near-miss identifier", () => {
    const verification = verifyAgentResponseAgainstEvidence(
      "Bảng `custmers` và `ordrs` cần kiểm tra lại.",
      [step('{ "rowCount": 5 }')],
      ["customers", "orders"],
    );
    expect(verification.ok).toBe(false);
    const suggestions = Object.fromEntries(
      verification.unsupportedIdentifiers.map((item) => [item.cited, item.suggestion]),
    );
    expect(suggestions.custmers).toBe("customers");
    expect(suggestions.ordrs).toBe("orders");
  });

  it("tolerates a single stray identifier below the limit", () => {
    const verification = verifyAgentResponseAgainstEvidence(
      "Chỉ mỗi bảng `ghosttable` là lạ.",
      [step('{ "rowCount": 5 }')],
    );
    expect(verification.ok).toBe(true);
    expect(verification.unsupportedIdentifiers).toHaveLength(1);
  });
});

describe("nearestKnownIdentifier", () => {
  it("suggests the closest known name within the edit-distance budget", () => {
    expect(nearestKnownIdentifier("custmer", ["customer", "orders", "products"])).toBe("customer");
  });

  it("returns undefined when nothing is close enough", () => {
    expect(nearestKnownIdentifier("xyzzy", ["customer", "orders"])).toBeUndefined();
  });
});
