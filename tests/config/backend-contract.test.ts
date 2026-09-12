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

/**
 * Cross-language contract (tech-debt audit D1): the frontend AI caps in
 * `src/config/ai-limits.ts` MUST equal the Rust source of truth in
 * `src-tauri/src/config.rs`. Reading the Rust file and comparing here means CI
 * fails the moment the two sides drift — no more silently mismatched literals.
 */
function rustUsizeConst(source: string, name: string): number {
  const match = source.match(
    new RegExp(`pub const ${name}\\s*:\\s*usize\\s*=\\s*([0-9_]+)`),
  );
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
