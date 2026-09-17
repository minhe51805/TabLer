/**
 * Minimal rule engine for `.claude/rules/*.md` — the developer-side prototype of the
 * in-app guardrail engine (see docs/architecture/AGENT_SKILLS.md).
 *
 * A rule is one markdown file:
 *
 *   ---
 *   name: block-force-push
 *   enabled: true
 *   event: bash          # bash | write | any
 *   pattern: git\s+push\s+.*--force
 *   action: block        # block | warn
 *   ---
 *
 *   Human-readable reason shown when the rule fires.
 *
 * Rules are compiled on every evaluation, so editing one takes effect on the next tool
 * call with no restart — the same hot-reload promise the hookify plugin makes.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    value = value.replace(/\s+#.*$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return { fields, body: (match[2] ?? "").trim() };
}

/** Read every enabled rule from a rules directory. A broken rule is skipped. */
export function loadRules(rulesDir) {
  if (!existsSync(rulesDir)) return [];
  const rules = [];
  for (const entry of readdirSync(rulesDir)) {
    if (!entry.endsWith(".md")) continue;
    let parsed;
    try {
      parsed = parseFrontmatter(readFileSync(join(rulesDir, entry), "utf8"));
    } catch {
      continue;
    }
    if (!parsed) continue;
    const { fields, body } = parsed;
    if (fields.enabled === "false") continue;
    if (!fields.name || !fields.pattern) continue;
    let regex;
    try {
      regex = new RegExp(fields.pattern, fields.flags ?? "");
    } catch {
      // A rule whose pattern does not compile is inert, never fatal.
      continue;
    }
    rules.push({
      file: entry,
      name: fields.name,
      event: fields.event ?? "any",
      action: fields.action ?? "warn",
      regex,
      message: body || `Rule "${fields.name}" matched.`,
    });
  }
  return rules;
}

function haystack(event, payload) {
  if (event === "bash") return payload.command ?? "";
  if (event === "write") {
    // `Write` supplies `content`; `Edit`/`MultiEdit` supply old_string/new_string and a
    // path. Including the path lets a rule target a location (e.g. src-tauri/src/bin/).
    return [
      payload.file_path,
      payload.path,
      payload.content,
      payload.new_string,
      payload.old_string,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [payload.command, payload.content, payload.new_string].filter(Boolean).join("\n");
}

/**
 * Evaluate the rules for one event. Returns matches in file order.
 * Policy: a rule engine error must never block a session, so evaluation is total and
 * any unexpected failure is reported as "no match" rather than thrown.
 */
export function evaluateRules(rulesDir, event, payload) {
  try {
    return loadRules(rulesDir)
      .filter((rule) => rule.event === event || rule.event === "any")
      .map((rule) => {
        const text = haystack(event, payload);
        rule.regex.lastIndex = 0;
        return rule.regex.test(text) ? rule : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
