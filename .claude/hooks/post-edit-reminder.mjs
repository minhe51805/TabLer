/**
 * PostToolUse hook — after a file is written, surface the follow-up command that the
 * file type requires. Advisory only; it never blocks.
 */
import { readFileSync } from "node:fs";

const REMINDERS = [
  {
    test: /^src-tauri\/.*\.rs$/,
    message:
      "Rust source changed — run `cargo fmt --manifest-path src-tauri/Cargo.toml` and " +
      "`cargo check --manifest-path src-tauri/Cargo.toml` before reporting success.",
  },
  {
    test: /^src-tauri\/skills\/.*\.(md|sql)$/,
    message:
      "Built-in skill pack changed — run `npm run check:agent-skills` to verify the " +
      "200-char description cap, the 8 000-char body cap and the tool allowlist.",
  },
  {
    test: /^(src|tests)\/.*\.(ts|tsx)$/,
    message:
      "TypeScript changed — run `npm run typecheck` and the matching test file " +
      "(`npx vitest run <path>`); the repo gates on `npm run check:frontend`.",
  },
  {
    test: /^plugins\/.*\/plugin\.json$/,
    message:
      "A plugin manifest changed — run `npm run build:plugin-registry` and commit the " +
      "regenerated `plugin-registry.json`, or CI's plugin check will fail.",
  },
  {
    test: /^(src-tauri\/Cargo\.toml|package\.json|src-tauri\/tauri.*\.json)$/,
    message:
      "Build manifest changed — run `npm run check:tauri-target` and, if this touches " +
      "the release config, `node scripts/check-release-contract.mjs`.",
  },
];

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

try {
  const payload = JSON.parse(readStdin() || "{}");
  const input = payload.tool_input ?? payload.toolInput ?? {};
  const raw = input.file_path ?? input.path ?? "";
  const path = String(raw)
    .replace(/\\/g, "/")
    .replace(/^.*?\/(?=src|src-tauri|tests|plugins)/, "");

  const messages = REMINDERS.filter((reminder) => reminder.test.test(path)).map(
    (reminder) => reminder.message,
  );
  if (messages.length > 0) {
    process.stdout.write(JSON.stringify({ systemMessage: messages.join("\n") }));
  }
} catch {
  // Advisory hook: never fail the tool call.
}
process.exit(0);
