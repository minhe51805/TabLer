import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_TOKEN_BUDGET,
  extractAgentUsageTokens,
} from "@/components/AISlidePanel/ai-agent-cost";

describe("extractAgentUsageTokens", () => {
  it("returns 0 for missing or malformed usage", () => {
    expect(extractAgentUsageTokens(null)).toBe(0);
    expect(extractAgentUsageTokens(undefined)).toBe(0);
    expect(extractAgentUsageTokens({})).toBe(0);
    expect(extractAgentUsageTokens({ total_tokens: "lots" })).toBe(0);
    expect(extractAgentUsageTokens({ total_tokens: -5 })).toBe(0);
    expect(extractAgentUsageTokens({ total_tokens: Number.NaN })).toBe(0);
  });

  it("prefers an explicit total when the provider reports one", () => {
    expect(extractAgentUsageTokens({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 137,
    })).toBe(137);
  });

  it("reads the Gemini usageMetadata total", () => {
    expect(extractAgentUsageTokens({ totalTokenCount: 512 })).toBe(512);
  });

  it("sums OpenAI prompt and completion components without a total", () => {
    expect(extractAgentUsageTokens({ prompt_tokens: 30, completion_tokens: 12 })).toBe(42);
  });

  it("sums Anthropic input and output components", () => {
    expect(extractAgentUsageTokens({ input_tokens: 80, output_tokens: 20 })).toBe(100);
  });

  it("sums Gemini prompt and candidate components", () => {
    expect(extractAgentUsageTokens({ promptTokenCount: 60, candidatesTokenCount: 25 })).toBe(85);
  });

  it("floors fractional counts to whole tokens", () => {
    expect(extractAgentUsageTokens({ prompt_tokens: 10.9, completion_tokens: 5.9 })).toBe(15);
  });

  it("exposes a positive default budget", () => {
    expect(DEFAULT_AGENT_TOKEN_BUDGET).toBeGreaterThan(0);
  });
});
