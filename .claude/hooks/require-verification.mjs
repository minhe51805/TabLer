/**
 * Stop hook — the completion gate.
 *
 * If the session edited tracked source and never ran a verification command, the stop is
 * blocked once with an explanation, so "done" cannot be claimed without evidence. The
 * `stop_hook_active` flag guards against a loop: the second stop always passes.
 *
 * Scoring input comes from the transcript only — nothing is inferred, so a session that
 * genuinely verified its work is never delayed.
 */
import { existsSync, readFileSync } from "node:fs";

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const VERIFY_COMMAND =
  /(npm run (check|test|lint|typecheck|eval|build|format)|npx vitest|cargo (test|check|fmt|clippy)|node scripts\/|tauri build|npm run check:agent-skills)/;
const TRACKED_PATH = /(^|\/)(src|src-tauri|tests|scripts|plugins)\//;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function decide() {
  let payload = {};
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    return null;
  }

  // Already blocked once for this stop: let it through rather than trap the session.
  if (payload.stop_hook_active) return null;

  const transcript = payload.transcript_path;
  if (!transcript || !existsSync(transcript)) return null;

  let edited = new Set();
  let verified = false;

  let lines;
  try {
    lines = readFileSync(transcript, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      const input = block.input ?? {};
      if (EDIT_TOOLS.has(block.name)) {
        const raw = String(input.file_path ?? input.path ?? "").replace(/\\/g, "/");
        if (TRACKED_PATH.test(raw)) edited.add(raw);
      } else if (block.name === "Bash" && VERIFY_COMMAND.test(String(input.command ?? ""))) {
        verified = true;
      }
    }
  }

  if (edited.size === 0 || verified) return null;

  const shown = [...edited]
    .slice(0, 6)
    .map((path) => `  - ${path}`)
    .join("\n");
  const more = edited.size > 6 ? `\n  … and ${edited.size - 6} more` : "";
  return {
    decision: "block",
    reason:
      `You edited ${edited.size} tracked source file(s) but ran no verification command:\n` +
      `${shown}${more}\n\n` +
      "Run the check that covers what you changed, then report its result:\n" +
      "  - Rust:   `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and `cargo check --manifest-path src-tauri/Cargo.toml`\n" +
      "  - TS/UI:  `npm run typecheck` and `npx vitest run <changed test>`\n" +
      "  - Skills: `npm run check:agent-skills`\n" +
      "  - Whole:  `npm run check:frontend`\n\n" +
      "If the change genuinely needs no check, say so explicitly and why. " +
      "Do not claim the work is complete without stating what you ran.",
  };
}

let result = null;
try {
  result = decide();
} catch {
  result = null;
}

if (result) {
  process.stdout.write(JSON.stringify(result));
}
process.exit(0);
