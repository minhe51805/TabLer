/**
 * PreToolUse hook — evaluates `.claude/rules/*.md` against the incoming tool call.
 *
 * Contract (see docs/architecture/AGENT_SKILLS.md):
 *   - `action: block` → the tool call is denied and the reason is returned to the model
 *     so it can correct itself. This is the equivalent of "exit 2 + stderr fed back".
 *   - `action: warn`  → the call proceeds, with the reason added as context.
 *   - no match        → the call proceeds silently.
 *
 * Failure policy: a broken rule engine must never break a session. Any internal error
 * exits 0 (allow) rather than blocking work.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateRules } from "./rule-engine.mjs";

const RULES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "rules");

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function decide(event) {
  let payload = {};
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    return 0;
  }

  const toolInput = payload.tool_input ?? payload.toolInput ?? {};
  const matches = evaluateRules(RULES_DIR, event, toolInput);
  if (matches.length === 0) return 0;

  const blocking = matches.filter((rule) => rule.action === "block");
  const warnings = matches.filter((rule) => rule.action !== "block");

  if (blocking.length > 0) {
    const reason = blocking
      .map((rule) => `[${rule.name} — ${rule.file}]\n${rule.message}`)
      .join("\n\n");
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `Blocked by project guardrail rule(s):\n\n${reason}\n\n` +
            "Adjust the command so it satisfies the rule, or explain to the user why the " +
            "rule should be relaxed. Do not retry the same command unchanged.",
        },
      }),
    );
    return 0;
  }

  process.stdout.write(
    JSON.stringify({
      systemMessage: warnings
        .map((rule) => `Guardrail warning [${rule.name}]: ${rule.message}`)
        .join("\n"),
    }),
  );
  return 0;
}

const event = process.argv[2] === "write" ? "write" : "bash";
let code = 0;
try {
  code = decide(event);
} catch {
  code = 0;
}
process.exit(code);
