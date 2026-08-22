import { describe, expect, it } from "vitest";
import {
  collectObservedNumbers,
  extractClaimedNumbers,
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
    expect(verifyAgentResponseAgainstEvidence(undefined, [])).toEqual({ ok: true, unsupported: [] });
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
