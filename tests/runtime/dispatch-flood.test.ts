import { describe, expect, it } from "vitest";
import sandboxGateSource from "../../src-tauri/src/commands/query/sandbox_gate.rs?raw";
import rateLimiterSource from "../../src-tauri/src/utils/rate_limiter.rs?raw";

describe("dispatch-flood gate contract", () => {
  it("keeps the 200-call Rust flood simulation bound to twenty driver calls", () => {
    expect(sandboxGateSource).toContain("for _ in 0..200");
    expect(sandboxGateSource).toContain("advance(Duration::from_millis(300))");
    expect(sandboxGateSource).toContain("driver_calls <= 20");
    expect(rateLimiterSource).toMatch(/Duration::from_secs\(60\),\s*20/);
    expect(rateLimiterSource).toMatch(/Duration::from_secs\(1\),\s*10/);
  });
});
