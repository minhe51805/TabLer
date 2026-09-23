import { describe, expect, it } from "vitest";
// Vite `?raw` import (typed by vite/client) reads the Rust source of truth as a
// string without Node's `fs`/`path`, so the test typechecks under the project's
// `types: ["vitest/globals"]` tsconfig.
import configRs from "../../src-tauri/src/config.rs?raw";
import {
  AI_MAX_CONTEXT_CHARS,
  AI_MAX_HISTORY_CHARS,
  AI_MAX_HISTORY_MESSAGES,
  AI_MAX_PROMPT_CHARS,
  AI_MAX_TOOLS_CHARS,
} from "@/config/ai-limits";
import { listAgentToolSpecs } from "@/components/AISlidePanel/tool-schema/parsing";
import { toOpenAIFunctionTools } from "@/components/AISlidePanel/tool-schema/provider-formats";

/**
 * Cross-language contract (tech-debt audit D1): the frontend AI caps in
 * `src/config/ai-limits.ts` MUST equal the Rust source of truth in
 * `src-tauri/src/config.rs`. Reading the Rust file and comparing here means CI
 * fails the moment the two sides drift — no more silently mismatched literals.
 */
function rustUsizeConst(source: string, name: string): number {
  const match = source.match(new RegExp(`pub const ${name}\\s*:\\s*usize\\s*=\\s*([0-9_]+)`));
  if (!match) {
    throw new Error(`Constant ${name} not found in config.rs`);
  }
  return Number.parseInt(match[1].replace(/_/g, ""), 10);
}

describe("frontend AI limits mirror the Rust backend (D1)", () => {
  const cases: Array<[string, number]> = [
    ["AI_MAX_PROMPT_CHARS", AI_MAX_PROMPT_CHARS],
    ["AI_MAX_CONTEXT_CHARS", AI_MAX_CONTEXT_CHARS],
    ["AI_MAX_HISTORY_MESSAGES", AI_MAX_HISTORY_MESSAGES],
    ["AI_MAX_HISTORY_CHARS", AI_MAX_HISTORY_CHARS],
    ["AI_MAX_TOOLS_CHARS", AI_MAX_TOOLS_CHARS],
  ];

  for (const [name, frontendValue] of cases) {
    it(`${name} matches config.rs`, () => {
      expect(rustUsizeConst(configRs, name)).toBe(frontendValue);
    });
  }
});

describe("AI_MAX_TOOLS_CHARS fits the real tool catalog", () => {
  it("the serialized catalog stays under the cap", () => {
    // The cap exists to reject abusive payloads, not the app's own catalog.
    // Serializing the real specs the way `toOpenAIFunctionTools` does and
    // comparing against the cap means adding a tool that pushes the payload
    // over the limit fails this test at build time instead of failing the
    // agent at runtime.
    const payload = JSON.stringify({
      tools: toOpenAIFunctionTools(listAgentToolSpecs()),
      tool_choice: "auto",
    });
    expect(payload.length).toBeLessThanOrEqual(AI_MAX_TOOLS_CHARS);
  });
});
