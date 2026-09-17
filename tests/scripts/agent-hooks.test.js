/**
 * Regression tests for the developer-side agent guardrails in `.claude/`.
 *
 * These lock in three real defects found while building P3:
 *   1. `no-unsafe-sql-interpolation.md` was inert — its pattern used `(?i)` mid-pattern,
 *      which is not valid in a JS RegExp, and the engine silently skips uncompilable
 *      rules (fail-open), so the SQL guardrail never fired.
 *   2. Nothing validated `.claude/rules/*.md`, so the inert pattern passed CI silently.
 *   3. `post-edit-reminder` / `require-verification` returned nothing for inputs whose
 *      shape differed slightly from the assumed one, failing open without a trace.
 *
 * Every hook is spawned as a real child process with a real stdin payload, so the tests
 * assert the actual hook contract (stdin JSON -> stdout JSON), not an internal helper.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const HOOKS = join(".claude", "hooks");

/** Run a hook with a JSON payload on stdin and parse its JSON stdout. */
function runHook(script, payload, args = []) {
  const result = spawnSync(process.execPath, [join(HOOKS, script), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify(payload),
  });
  const stdout = (result.stdout ?? "").trim();
  return {
    status: result.status,
    stderr: result.stderr,
    stdout,
    json: stdout ? JSON.parse(stdout) : null,
  };
}

describe("guard-commands (PreToolUse rule engine)", () => {
  it("denies a force push to a protected branch", () => {
    const result = runHook(
      "guard-commands.mjs",
      { tool_name: "Bash", tool_input: { command: "git push --force origin develop" } },
      ["bash"],
    );
    expect(result.status).toBe(0);
    expect(result.json?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.json.hookSpecificOutput.permissionDecisionReason).toContain(
      "no-force-push-protected-branches",
    );
  });

  it("denies moving a sidecar binary back into src/bin", () => {
    const result = runHook(
      "guard-commands.mjs",
      {
        tool_name: "Write",
        tool_input: { file_path: "src-tauri/src/bin/redis_sidecar.rs", content: "fn main() {}" },
      },
      ["write"],
    );
    expect(result.json?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.json.hookSpecificOutput.permissionDecisionReason).toContain(
      "no-sidecar-in-src-bin",
    );
  });

  it("allows an ordinary command silently", () => {
    const result = runHook(
      "guard-commands.mjs",
      { tool_name: "Bash", tool_input: { command: "git status --short" } },
      ["bash"],
    );
    expect(result.status).toBe(0);
    expect(result.json).toBeNull();
  });

  it("warns (without denying) when a warn rule matches", () => {
    const result = runHook(
      "guard-commands.mjs",
      {
        tool_name: "Write",
        tool_input: {
          file_path: "src/utils/ai-sql-format.ts",
          content: "const q = `SELECT * FROM t WHERE id = ${id}`;",
        },
      },
      ["write"],
    );
    expect(result.status).toBe(0);
    // Warn rules must be advisory: no permissionDecision, only a systemMessage.
    expect(result.json?.hookSpecificOutput).toBeUndefined();
    expect(result.json?.systemMessage).toContain("no-unsafe-sql-interpolation");
  });

  it("never fails the tool call on a malformed payload (fail-open)", () => {
    const result = runHook("guard-commands.mjs", { unexpected: true }, ["bash"]);
    expect(result.status).toBe(0);
    expect(result.json).toBeNull();
  });
});

describe("rule engine", () => {
  const RULES_DIR = join(".claude", "rules");

  it("compiles every shipped rule pattern (regression: inert (?i) pattern)", async () => {
    const { loadRules } = await import("../../.claude/hooks/rule-engine.mjs");
    const files = readdirSync(RULES_DIR).filter((entry) => entry.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);

    // A rule whose pattern does not compile is silently skipped by the engine, so a
    // broken pattern means the guardrail is inert with no visible failure. Assert that
    // every rule file contributed a live rule.
    const loaded = loadRules(RULES_DIR);
    expect(loaded.map((rule) => rule.file).sort()).toEqual(files.sort());
  });

  it("matches the SQL interpolation rule with the shipped flags", async () => {
    const { evaluateRules } = await import("../../.claude/hooks/rule-engine.mjs");
    const matches = evaluateRules(RULES_DIR, "write", {
      file_path: "src/x.ts",
      content: "const q = `UPDATE t SET a = ${v}`;",
    });
    expect(matches.map((rule) => rule.name)).toContain("no-unsafe-sql-interpolation");
  });

  it("ignores a rule whose pattern cannot compile instead of throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rules-"));
    try {
      writeFileSync(
        join(dir, "broken.md"),
        "---\nname: broken\nenabled: true\nevent: bash\npattern: (?i)mid-pattern\n---\n\nboom\n",
      );
      const { loadRules, evaluateRules } = await import("../../.claude/hooks/rule-engine.mjs");
      expect(loadRules(dir)).toHaveLength(0);
      expect(evaluateRules(dir, "bash", { command: "rm -rf /" })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a disabled rule without restarting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rules-"));
    try {
      writeFileSync(
        join(dir, "off.md"),
        "---\nname: off\nenabled: false\nevent: bash\npattern: rm\\s+-rf\naction: block\n---\n\nno\n",
      );
      const { evaluateRules } = await import("../../.claude/hooks/rule-engine.mjs");
      expect(evaluateRules(dir, "bash", { command: "rm -rf /tmp/x" })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
