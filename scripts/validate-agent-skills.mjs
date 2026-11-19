/**
 * Agent-asset contract validator.
 *
 * Guards the built-in Agent Skill pack in `src-tauri/skills/` against the limits the
 * Rust loader in `src-tauri/src/ai_skills/` enforces at runtime. A skill that breaks
 * one of these limits does not fail loudly in the app — it is silently truncated or
 * becomes undiscoverable — so it must fail here instead.
 *
 * Checks per skill directory:
 *   1. `SKILL.md` exists and its frontmatter parses.
 *   2. `name:` matches the directory name (the discovery contract).
 *   3. `description:` is present and within MAX_SKILL_DESCRIPTION_CHARS.
 *   4. The body is within MAX_SKILL_BODY_CHARS.
 *   5. Every file under `references/` and `scripts/` is within MAX_SKILL_RESOURCE_CHARS.
 *   6. Every `allowed-tools:` entry names a real tool from the agent tool schema.
 *
 * Usage: node scripts/validate-agent-skills.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// Contract mirrors. CHECKED, not hand-synced: `crossCheckRustConstants` walks the
// RUST_CONTRACTS table below, extracts each Rust declaration, and fails on drift —
// so "keep in sync" stopped being a hope.
const MAX_SKILL_DESCRIPTION_CHARS = 200;
const MAX_SKILL_BODY_CHARS = 8000;
const MAX_SKILL_RESOURCE_CHARS = 12000;
const MAX_SKILL_ALLOWED_TOOLS = 32;
const MAX_SKILLS_PER_CATALOG = 32;
const MAX_SKILL_RESOURCES = 64;
const MAX_COMMAND_BODY_CHARS = 8000;
const MAX_COMMAND_ALLOWED_TOOLS = 32;

/**
 * The contract registry: every cross-side constant agreement in one table.
 *
 * Per row: `file` (Rust authority), `pattern` (matches the constant declarations),
 * and a JS side that is one of:
 *   - `js`: checked pairs against this script's own working constants — value must
 *     EQUAL the Rust number (or `rel: "<="` for budget-vs-storage pairs);
 *   - `jsFile` + `jsPattern`: the JS authority lives in a frontend file — extract it
 *     there, so the validator never becomes a second copy of the number;
 * plus `captureOnly` (names the regex must find, values recorded but with no JS
 * twin yet — growth becomes copy-paste instead of archaeology).
 *
 * Bidirectional by construction: a Rust match that is in neither `js`/`jsFile` nor
 * `captureOnly` fails with the offender named, and an entry the regex cannot find
 * in Rust fails too. A pattern that matches nothing at all is a loud failure (the
 * file drifted from the expected shape), never a silent pass.
 */
const RUST_CONTRACTS = [
  {
    file: "src-tauri/src/ai_skills/types.rs",
    // MAX_SKILLS_PER_CATALOG shares the MAX_SKILL prefix family; [A-Z_]* (not
    // _[A-Z_]+) keeps it in the same match.
    pattern: /MAX_SKILL[A-Z_]*:\s*usize\s*=\s*([\d_]+);/g,
    js: {
      MAX_SKILL_DESCRIPTION_CHARS,
      MAX_SKILL_BODY_CHARS,
      MAX_SKILL_RESOURCE_CHARS,
      MAX_SKILL_ALLOWED_TOOLS,
      MAX_SKILLS_PER_CATALOG,
      MAX_SKILL_RESOURCES,
    },
  },
  {
    file: "src-tauri/src/agent_commands/types.rs",
    pattern: /MAX_COMMAND[A-Z_]*:\s*usize\s*=\s*([\d_]+);/g,
    js: {
      MAX_COMMAND_BODY_CHARS,
      MAX_COMMAND_ALLOWED_TOOLS,
    },
    captureOnly: ["MAX_COMMANDS_PER_ROOT"],
  },
  {
    file: "src-tauri/src/agent_memory.rs",
    pattern: /MAX_MEMORY_ENTRIES:\s*usize\s*=\s*([\d_]+);/g,
    // The JS side is the frontend file, not a copy here: the prompt budget is
    // owned by `ai-agent-controller-prompt.ts`. Storage cap vs prompt budget:
    // the FE shows the top 24 of ≤32 after its relevance sort, so equality is
    // wrong by design — see the paired comments on both constants. The two
    // constants have different names on purpose (storage vs budget).
    rustName: "MAX_MEMORY_ENTRIES",
    jsFile: "src/components/AISlidePanel/ai-agent-controller-prompt.ts",
    jsPattern: /MAX_AGENT_MEMORY_INDEX_ENTRIES = (\d+);/,
    jsName: "MAX_AGENT_MEMORY_INDEX_ENTRIES",
    rel: "<=",
  },
  {
    file: "src-tauri/src/agent_rules/types.rs",
    pattern: /MAX_[A-Z_]+:\s*usize\s*=\s*([\d_ *]+);/g,
    js: {},
    captureOnly: ["MAX_RULES_PER_ROOT", "MAX_STATEMENT_LEN", "MAX_PATTERN_LEN"],
  },
];

/**
 * Evaluate a restricted Rust integer literal: `8_000`, or a pure product of
 * integers (`2 * 1024 * 1024`). The character class is deliberately limited to
 * digits, underscores, spaces and `*` — anything else fails loudly instead of
 * being eval'd.
 */
function parseRustInt(expr) {
  const cleaned = expr.replace(/[\s_]/g, "");
  if (!/^\d+(\*\d+)*$/.test(cleaned)) {
    throw new Error(`unsupported Rust integer expression: \`${expr.trim()}\``);
  }
  return cleaned.split("*").reduce((product, part) => product * Number(part), 1);
}

/**
 * Walk the registry and report every divergence from the Rust authority.
 */
function crossCheckRustConstants(reported) {
  for (const contract of RUST_CONTRACTS) {
    const source = readFileSync(contract.file, "utf8");
    const rust = {};
    let matches = 0;
    for (const match of source.matchAll(contract.pattern)) {
      matches += 1;
      let value;
      try {
        value = parseRustInt(match[1]);
      } catch (error) {
        reported(contract.file, `contract cross-check: ${error.message}`);
        continue;
      }
      rust[match[0].split(":")[0].trim()] = value;
    }
    if (matches === 0) {
      reported(
        contract.file,
        "contract cross-check: the extraction pattern matched nothing — the Rust file no longer matches the expected declaration shape",
      );
      continue;
    }

    const relation = contract.rel === "<=" ? (js, rust) => js <= rust : (js, rust) => js === rust;

    if (contract.jsFile) {
      const rustName = contract.rustName ?? contract.jsName;
      const jsMatch = readFileSync(contract.jsFile, "utf8").match(contract.jsPattern);
      if (!jsMatch) {
        reported(
          contract.jsFile,
          `contract cross-check: could not extract \`${contract.jsName}\` — the frontend declaration no longer matches the expected shape`,
        );
      } else {
        const jsValue = Number(jsMatch[1]);
        const rustValue = rust[rustName];
        if (rustValue === undefined) {
          reported(
            contract.file,
            `contract cross-check: could not find \`${rustName}\` — the Rust declaration no longer matches the expected shape`,
          );
        } else if (!relation(jsValue, rustValue)) {
          reported(
            contract.file,
            `contract cross-check: ${contract.jsName} FE ${jsValue} vs Rust ${rustValue}${
              contract.rel === "<="
                ? " — the prompt budget must stay ≤ the storage cap"
                : " — update the FE mirror together with the Rust constant"
            }`,
          );
        }
      }
    }
    for (const [name, jsValue] of Object.entries(contract.js ?? {})) {
      const rustValue = rust[name];
      if (rustValue === undefined) {
        reported(
          contract.file,
          `contract cross-check: could not find \`${name}\` — the Rust declaration no longer matches the expected shape`,
        );
      } else if (!relation(jsValue, rustValue)) {
        reported(
          contract.file,
          `contract cross-check: ${name} JS ${jsValue} vs Rust ${rustValue}${
            contract.rel === "<="
              ? " — the prompt budget must stay ≤ the storage cap"
              : " — update the mirror together with the Rust constant"
          }`,
        );
      }
    }
    for (const name of contract.captureOnly ?? []) {
      if (rust[name] === undefined) {
        reported(
          contract.file,
          `contract cross-check: capture-only \`${name}\` no longer matches in Rust — update this registry row`,
        );
      }
    }
    for (const rustName of Object.keys(rust)) {
      const inJs =
        (contract.js && contract.js[rustName] !== undefined) ||
        rustName === (contract.rustName ?? contract.jsName);
      if (!inJs && !(contract.captureOnly ?? []).includes(rustName)) {
        reported(
          contract.file,
          `contract cross-check: Rust declares \`${rustName} = ${rust[rustName]}\` but this registry has no row for it — add it to \`js\` or \`captureOnly\``,
        );
      }
    }
  }

  // List agreement (not a numeric constant, so not a registry row): the injectable
  // context keys must be the same set on both sides.
  const agentTypes = readFileSync("src-tauri/src/agent_commands/types.rs", "utf8");
  const keysMatch = agentTypes.match(/INJECTABLE_CONTEXT_KEYS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\]/);
  if (!keysMatch) {
    report(
      "contract cross-check",
      "could not find `INJECTABLE_CONTEXT_KEYS` in src-tauri/src/agent_commands/types.rs",
    );
  } else {
    const rustKeys = [...keysMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    const jsKeys = [...INJECTABLE_CONTEXT_KEYS].sort();
    if (JSON.stringify(rustKeys) !== JSON.stringify(jsKeys)) {
      report(
        "contract cross-check",
        `INJECTABLE_CONTEXT_KEYS: JS [${jsKeys.join(", ")}] != Rust [${rustKeys.join(", ")}]`,
      );
    }
  }
}

/**
 * Truncation-surfacing gate: every `truncate(`/`split_off(` that sits within a
 * few lines of a named `MAX_*` cap must either surface (an `errors.push` /
 * `report`-style call in the same function) or carry an explicit `// benign-cap:`
 * marker with the reason. Anything else is the silent-death class the audit
 * kept finding — a user with one more row than the author guessed, and no
 * explanation anywhere. Scanned paths are the agent-contract crates; new crates
 * with caps belong here too.
 */
const TRUNCATION_SCAN_ROOTS = [
  "src-tauri/src/ai_skills",
  "src-tauri/src/agent_commands",
  "src-tauri/src/agent_rules",
  "src-tauri/src/agent_memory.rs",
  "src-tauri/src/storage",
];

function checkTruncationSurfacing(reported) {
  const rustFiles = [];
  for (const scanRoot of TRUNCATION_SCAN_ROOTS) {
    if (!existsSync(scanRoot)) continue;
    if (statSync(scanRoot).isFile()) {
      rustFiles.push(scanRoot);
      continue;
    }
    for (const entry of readdirSync(scanRoot)) {
      const candidate = join(scanRoot, entry);
      if (statSync(candidate).isFile() && entry.endsWith(".rs")) rustFiles.push(candidate);
    }
  }
  for (const rustFile of rustFiles) {
    const lines = readFileSync(rustFile, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/\.truncate\(|\.split_off\(/.test(line)) return;
      const context = lines.slice(Math.max(0, index - 12), index + 6);
      const nearCap = context.some((contextLine) => /MAX_[A-Z_]+/.test(contextLine));
      if (!nearCap) return;
      const surfaces = context.some((contextLine) =>
        /(errors\.push|report\(|benign-cap|is_some\(\)|Ignoring the rest|ignoring the rest)/.test(
          contextLine,
        ),
      );
      if (!surfaces) {
        reported(
          rustFile,
          `line ${index + 1}: truncates near a MAX_* cap without surfacing or a \`// benign-cap:\` marker — either push a load error/notification or declare the cap benign`,
        );
      }
    });
  }
}

const SKILLS_ROOT = "src-tauri/skills";
const SKILL_MD = "SKILL.md";
const RESOURCE_DIRS = ["references", "scripts"];

// Developer-side agent assets. These are not loaded by the app, but a broken one is just
// as silent: an uncompilable rule pattern is skipped by the rule engine (fail-open), so it
// simply never fires and nobody notices. `(?i)` in a JS pattern was exactly that bug.
const CLAUDE_ROOT = ".claude";
const RULE_EVENTS = new Set(["bash", "write", "any"]);
const RULE_ACTIONS = new Set(["block", "warn"]);
const AGENT_MODELS = new Set(["inherit", "sonnet", "opus", "haiku"]);
const AGENT_COLORS = new Set(["blue", "cyan", "green", "yellow", "magenta", "red"]);
const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

/**
 * Frontmatter keys this repo uses. A multi-line value ends when a continuation line
 * opens one of these keys, which is how `parseFrontmatter` finds where it stops.
 */
const KNOWN_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "version",
  "license",
  "model",
  "effort",
  "tools",
  "allowed-tools",
  "allowed_tools",
  "argument-hint",
  "event",
  "pattern",
  "action",
  "flags",
  "enabled",
  "inject",
]);

/**
 * Keys whose value may span multiple lines. Only `description` does: the documented
 * Claude Code agent format puts the triggering `<example>` blocks inside the
 * description value itself, on their own lines.
 *
 * The in-app runtime parser (`parse_skill_md` in `src-tauri/src/ai_skills/`) reads
 * just the first line of `description`, so multi-line descriptions are only valid for
 * `.claude/` assets, never for shipped skills — the skill loop below enforces that.
 */
const MULTILINE_KEYS = new Set(["description"]);

/** Tools the agent can actually call, read from the single source of truth. */
function readToolNames() {
  // specs.ts composes sibling specs-*.ts files (one file per concern) —
  // scan the whole directory so a new spec module can't be invisible to
  // the tool allowlist validation.
  const dir = "src/components/AISlidePanel/tool-schema";
  const files = readdirSync(dir).filter((f) => /^specs[^/]*\.ts$/.test(f) || f === "specs.ts");
  const names = new Set();
  const pattern = /^\s*name:\s*"([a-z0-9_]+)"/gm;
  for (const file of files) {
    const src = readFileSync(join(dir, file), "utf8");
    let match;
    while ((match = pattern.exec(src)) !== null) names.add(match[1]);
  }
  return names;
}

function cleanScalar(value) {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

/**
 * Frontmatter reader: `---` fences, `key: value` scalars (bare or quoted), and
 * `allowed-tools` as an inline or block list.
 *
 * A key in {@link MULTILINE_KEYS} keeps consuming lines until a line opens another
 * key this repo knows about ({@link KNOWN_FRONTMATTER_KEYS}). That is how the
 * documented agent format carries `<example>` blocks: they live inside the
 * `description` value, and lines such as `Context:` / `user:` / `assistant:` inside
 * them must not be mistaken for new frontmatter keys.
 *
 * Keys that spanned lines are returned in `multilineKeys` so the skill loop can
 * reject them: the runtime parser (`parse_skill_md` in `ai_skills/parse.rs`) reads only the
 * first line of a value, so a multi-line `description` silently loses its triggers.
 */
function parseFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---")
    return { fields: {}, multilineKeys: new Set(), body: text, hasFrontmatter: false };

  const fields = {};
  const multilineKeys = new Set();
  let index = 1;
  let currentListKey = null;
  let multilineKey = null;
  let multilineLines = [];

  const flushMultiline = () => {
    if (!multilineKey) return;
    fields[multilineKey] = multilineLines.join("\n").trimEnd();
    // Only a key that actually consumed a continuation line is "multi-line"; a key whose
    // value simply happened to be the last one before `---` is still a single line.
    if (multilineLines.length > 1) multilineKeys.add(multilineKey);
    multilineKey = null;
    multilineLines = [];
  };

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") break;

    if (multilineKey) {
      const nextKey = /^([A-Za-z0-9_-]+):/.exec(line);
      if (nextKey && KNOWN_FRONTMATTER_KEYS.has(nextKey[1])) {
        flushMultiline();
        // Fall through: this line opens the next field.
      } else {
        multilineLines.push(line);
        continue;
      }
    }

    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentListKey) {
      fields[currentListKey].push(cleanScalar(listItem[1]));
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;

    const [, key, value] = pair;
    if (value.trim() === "") {
      // Either an empty scalar or the head of a block list; decide on the next line.
      fields[key] = [];
      currentListKey = key;
      continue;
    }
    currentListKey = null;
    if (MULTILINE_KEYS.has(key)) {
      multilineKey = key;
      multilineLines = [value.trim()];
      continue;
    }
    fields[key] = cleanScalar(value);
  }

  flushMultiline();

  return { fields, multilineKeys, body: lines.slice(index + 1).join("\n"), hasFrontmatter: true };
}

/** Splits an inline list (`[a, b]` or `a, b`) into names. */
function inlineList(value) {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => cleanScalar(item))
    .filter(Boolean);
}

function listDir(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path).filter((entry) => statSync(join(path, entry)).isFile());
}

const problems = [];
const notes = [];

function report(skill, message) {
  problems.push(`${skill}: ${message}`);
}

const toolNames = readToolNames();
if (toolNames.size === 0) {
  process.stderr.write("Could not read any tool names from tool-schema/specs.ts\n");
  process.exit(1);
}

const skillDirs = existsSync(SKILLS_ROOT)
  ? readdirSync(SKILLS_ROOT).filter((entry) => statSync(join(SKILLS_ROOT, entry)).isDirectory())
  : [];

if (skillDirs.length === 0) {
  process.stdout.write(`No built-in skill pack at ${SKILLS_ROOT} — skipping skill checks.\n`);
}

for (const dir of skillDirs.sort()) {
  const skillDir = join(SKILLS_ROOT, dir);
  const skillMd = join(skillDir, SKILL_MD);

  if (!existsSync(skillMd)) {
    report(dir, `missing ${SKILL_MD}`);
    continue;
  }

  const raw = readFileSync(skillMd, "utf8");
  const { fields, body, hasFrontmatter, multilineKeys } = parseFrontmatter(raw);

  if (!hasFrontmatter) {
    report(dir, "SKILL.md has no `---` frontmatter block");
    continue;
  }

  // Unlike .claude/ agents, skills are parsed by the Rust runtime, which reads only the
  // first line of a value. A wrapped description is therefore silently truncated.
  if (multilineKeys.has("description")) {
    report(
      dir,
      "`description:` spans multiple lines — the runtime parser reads only the first line, " +
        "so every trigger after the wrap is lost; keep it on one line",
    );
  }

  const declaredName = typeof fields.name === "string" ? fields.name : "";
  if (!declaredName) {
    report(dir, "frontmatter is missing `name:`");
  } else if (declaredName !== dir) {
    report(dir, `\`name: ${declaredName}\` does not match the directory name`);
  }

  const description = typeof fields.description === "string" ? fields.description : "";
  if (!description) {
    report(dir, "frontmatter is missing `description:` (the skill can never fire)");
  } else if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    report(
      dir,
      `description is ${description.length} chars, over the ${MAX_SKILL_DESCRIPTION_CHARS}-char cap ` +
        "(it is truncated at runtime and its trailing triggers are lost)",
    );
  }

  if (body.length > MAX_SKILL_BODY_CHARS) {
    report(
      dir,
      `body is ${body.length} chars, over the ${MAX_SKILL_BODY_CHARS}-char cap — ` +
        "move detail into references/ and load it with read_skill_resource",
    );
  }

  // `allowed-tools` is either a block list (array, possibly empty) or an inline string.
  const rawTools = fields["allowed-tools"] ?? fields.allowed_tools ?? [];
  const allowedTools = Array.isArray(rawTools) ? rawTools : inlineList(rawTools);

  if (allowedTools.length > MAX_SKILL_ALLOWED_TOOLS) {
    report(
      dir,
      `${allowedTools.length} allowed-tools entries, over the ${MAX_SKILL_ALLOWED_TOOLS} cap`,
    );
  }
  for (const tool of allowedTools) {
    if (!toolNames.has(tool)) {
      report(dir, `allowed-tools names an unknown tool: "${tool}"`);
    }
  }

  for (const resourceDir of RESOURCE_DIRS) {
    for (const file of listDir(join(skillDir, resourceDir)).sort()) {
      const size = readFileSync(join(skillDir, resourceDir, file), "utf8").length;
      if (size > MAX_SKILL_RESOURCE_CHARS) {
        report(
          dir,
          `${resourceDir}/${file} is ${size} chars, over the ${MAX_SKILL_RESOURCE_CHARS}-char cap`,
        );
      }
    }
  }
  // The Rust loader silently stops enumerating a skill's resources at
  // MAX_SKILL_RESOURCES (benign-cap in ai_skills/parse.rs) — hold the shipped
  // pack to the same number so a built-in never relies on that trim.
  const resourceCount = RESOURCE_DIRS.reduce(
    (total, resourceDir) => total + listDir(join(skillDir, resourceDir)).length,
    0,
  );
  if (resourceCount > MAX_SKILL_RESOURCES) {
    report(
      dir,
      `${resourceCount} resource files, over the ${MAX_SKILL_RESOURCES}-resource cap the runtime enforces`,
    );
  }

  notes.push(
    `${dir}: ${body.length} body chars, ${description.length} description chars` +
      (allowedTools.length ? `, tools=[${allowedTools.join(", ")}]` : ""),
  );
}

// ---------------------------------------------------------------------------------------
// Developer-side agent assets under `.claude/`.
//
// These are consumed by the coding agent, not by the app. The rule patterns are the part
// that fails silently: `loadRules` in `.claude/hooks/rule-engine.mjs` deliberately skips a
// rule whose `pattern` does not compile (`catch { continue; }`), so an invalid pattern means
// the guardrail is inert with no error anywhere. `(?i)` — valid in PCRE, invalid in
// JavaScript — produced exactly that, so every pattern is compiled here.
// ---------------------------------------------------------------------------------------

/** Files in a `.claude` subdirectory, or [] when the directory is absent. */
function claudeFiles(...segments) {
  const dir = join(CLAUDE_ROOT, ...segments);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => statSync(join(dir, entry)).isFile())
    .sort();
}

/** Frontmatter fields of a `.claude` asset, or null when it has no frontmatter. */
function readAsset(relativePath) {
  const { fields, body, hasFrontmatter } = parseFrontmatter(readFileSync(relativePath, "utf8"));
  if (!hasFrontmatter) {
    report(relativePath, "has no `---` frontmatter block");
    return null;
  }
  return { fields, body };
}

/** The declared `name:` must match the file's basename (the discovery contract). */
function checkNameMatchesFile(relativePath, fields, label) {
  const declared = typeof fields.name === "string" ? fields.name : "";
  if (!declared) {
    report(relativePath, `${label} frontmatter is missing \`name:\``);
    return;
  }
  const basename = relativePath.split("/").pop().replace(/\.md$/, "");
  if (declared !== basename) {
    report(relativePath, `\`name: ${declared}\` does not match the file name \`${basename}\``);
  }
}

const ruleFiles = claudeFiles("rules");
const commandFiles = claudeFiles("commands");
const agentFiles = claudeFiles("agents");

for (const ruleFile of ruleFiles) {
  const relativePath = `${CLAUDE_ROOT}/rules/${ruleFile}`;
  const asset = readAsset(relativePath);
  if (!asset) continue;
  const { fields } = asset;

  checkNameMatchesFile(relativePath, fields, "rule");

  const pattern = typeof fields.pattern === "string" ? fields.pattern : "";
  if (!pattern) {
    report(relativePath, "rule has no `pattern:` (it can never fire)");
  } else {
    // Mirrors `loadRules`: `new RegExp(pattern, fields.flags ?? "")`.
    const flags = typeof fields.flags === "string" ? fields.flags : "";
    if (!/^[dgimsuvy]*$/.test(flags) || new Set(flags).size !== flags.length) {
      report(relativePath, `\`flags: ${flags}\` is not a valid JavaScript RegExp flag set`);
    }
    try {
      new RegExp(pattern, flags);
    } catch (error) {
      report(
        relativePath,
        `\`pattern:\` does not compile as a JavaScript RegExp (${error.message}) — the rule ` +
          "engine skips uncompilable rules, so this guardrail is inert. JavaScript has no " +
          "inline-flag syntax: use `flags: i` instead of `(?i)`",
      );
    }
  }

  const event = typeof fields.event === "string" ? fields.event : "";
  if (!event) {
    report(relativePath, "rule has no `event:` (bash | write | any)");
  } else if (!RULE_EVENTS.has(event)) {
    report(relativePath, `\`event: ${event}\` is not one of ${[...RULE_EVENTS].join(" | ")}`);
  }

  const action = typeof fields.action === "string" ? fields.action : "";
  if (!action) {
    report(relativePath, "rule has no `action:` (block | warn)");
  } else if (!RULE_ACTIONS.has(action)) {
    report(relativePath, `\`action: ${action}\` is not one of ${[...RULE_ACTIONS].join(" | ")}`);
  }

  if (asset.body.trim().length === 0) {
    report(relativePath, "rule has no message body — the model is blocked without a reason");
  }

  notes.push(`rule ${fields.name ?? ruleFile}: event=${event} action=${action}`);
}

for (const agentFile of agentFiles) {
  const relativePath = `${CLAUDE_ROOT}/agents/${agentFile}`;
  const asset = readAsset(relativePath);
  if (!asset) continue;
  const { fields } = asset;

  const name = typeof fields.name === "string" ? fields.name : "";
  if (!name) {
    report(relativePath, "agent frontmatter is missing `name:`");
  } else if (!AGENT_NAME_PATTERN.test(name)) {
    report(
      relativePath,
      `\`name: ${name}\` is invalid — lowercase letters, digits and hyphens only, ` +
        "3-50 characters, must start and end alphanumeric",
    );
  } else if (name !== agentFile.replace(/\.md$/, "")) {
    report(relativePath, `\`name: ${name}\` does not match the file name`);
  }

  // The description is the only trigger surface: without concrete <example> blocks the
  // agent is never selected, which looks identical to the agent not existing.
  const description = typeof fields.description === "string" ? fields.description : "";
  if (!description) {
    report(relativePath, "agent frontmatter is missing `description:` (it can never trigger)");
  } else if (!/use this agent when/i.test(description)) {
    report(relativePath, 'agent `description:` should open with "Use this agent when…"');
  }
  if (!description.includes("<example>")) {
    report(
      relativePath,
      "agent `description:` has no `<example>` block — add 2-4 concrete triggers",
    );
  }

  const model = typeof fields.model === "string" ? fields.model : "";
  if (!model) report(relativePath, "agent is missing `model:` (use `inherit` unless justified)");
  else if (!AGENT_MODELS.has(model)) {
    report(relativePath, `\`model: ${model}\` is not one of ${[...AGENT_MODELS].join(" | ")}`);
  }

  const color = typeof fields.color === "string" ? fields.color : "";
  if (!color) report(relativePath, "agent is missing `color:`");
  else if (!AGENT_COLORS.has(color)) {
    report(relativePath, `\`color: ${color}\` is not one of ${[...AGENT_COLORS].join(" | ")}`);
  }

  notes.push(`agent ${name}: model=${model} color=${color}`);
}

for (const commandFile of commandFiles) {
  const relativePath = `${CLAUDE_ROOT}/commands/${commandFile}`;
  const asset = readAsset(relativePath);
  if (!asset) continue;
  const { fields, body } = asset;

  if (typeof fields.description !== "string" || !fields.description.trim()) {
    report(
      relativePath,
      "command frontmatter is missing `description:` (it never shows in the menu)",
    );
  }
  if (body.trim().length === 0) {
    report(relativePath, "command has an empty body — it does nothing when invoked");
  }

  notes.push(`command ${commandFile.replace(/\.md$/, "")}`);
}

// ---------------------------------------------------------------------------------------
// Developer-layer skills (`.claude/skills/*.md`).
//
// These are Claude Code skills used by the coding agents that build this repo — a
// different system from the shipped pack above (AGENTS.md §8). Nothing at runtime parses
// them, so a broken one fails silently: a missing `name:` breaks the discovery contract,
// and a missing `description:` means the skill never auto-triggers. Same shape of check
// as the `.claude` commands above, kept deliberately light.
// ---------------------------------------------------------------------------------------

const claudeSkillFiles = claudeFiles("skills");

for (const skillFile of claudeSkillFiles) {
  const relativePath = `${CLAUDE_ROOT}/skills/${skillFile}`;
  const asset = readAsset(relativePath);
  if (!asset) continue;
  const { fields, body } = asset;

  checkNameMatchesFile(relativePath, fields, "skill");

  if (typeof fields.description !== "string" || !fields.description.trim()) {
    report(relativePath, "skill frontmatter is missing `description:` (it never auto-triggers)");
  }
  if (body.trim().length === 0) {
    report(relativePath, "skill has an empty body — it does nothing when loaded");
  }

  notes.push(`claude-skill ${skillFile.replace(/\.md$/, "")}`);
}

// ---------------------------------------------------------------------------------------
// ZCode-discoverable mirrors (`.zcode/skills/<name>/SKILL.md`).
//
// ZCode's discovery roots include workspace `.zcode/skills` but NOT `.claude/skills` —
// so a dev-layer skill that only exists in the Claude Code shape never loads there. The
// convention: `.claude/skills/<name>.md` is the tracked canonical copy, and a mirror at
// `.zcode/skills/<name>/SKILL.md` makes it discoverable to ZCode sessions in this repo.
// This walk checks the mirror's frontmatter and, when both copies exist, fails on body
// drift between them (the mirror carries the same sync note).
// ---------------------------------------------------------------------------------------

const zcodeSkillsDir = join(".zcode", "skills");
const zcodeSkillDirs = existsSync(zcodeSkillsDir)
  ? readdirSync(zcodeSkillsDir).filter((entry) =>
      statSync(join(zcodeSkillsDir, entry)).isDirectory(),
    )
  : [];

for (const dirName of zcodeSkillDirs) {
  const relativePath = `.zcode/skills/${dirName}/SKILL.md`;
  if (!existsSync(relativePath)) {
    report(relativePath, "mirror directory has no SKILL.md (ZCode requires that exact name)");
    continue;
  }
  const asset = readAsset(relativePath);
  if (!asset) continue;
  const { fields, body } = asset;

  // ZCode's contract: frontmatter `name` matches the DIRECTORY name (the file is
  // always SKILL.md here, so the flat-file basename check does not apply).
  const declared = typeof fields.name === "string" ? fields.name : "";
  if (!declared) {
    report(relativePath, "mirror skill frontmatter is missing `name:`");
  } else if (declared !== dirName) {
    report(relativePath, `\`name: ${declared}\` does not match the directory name \`${dirName}\``);
  }

  if (typeof fields.description !== "string" || !fields.description.trim()) {
    report(relativePath, "mirror skill frontmatter is missing `description:`");
  }
  if (body.trim().length === 0) {
    report(relativePath, "mirror skill has an empty body");
  }

  const canonicalRelative = `${CLAUDE_ROOT}/skills/${dirName}.md`;
  if (existsSync(canonicalRelative)) {
    const canonicalAsset = readAsset(canonicalRelative);
    if (canonicalAsset) {
      // HTML comments are annotations (the mirror carries a sync note the
      // canonical copy does not), so compare bodies with them stripped.
      const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, "").trim();
      if (stripComments(canonicalAsset.body) !== stripComments(body)) {
        report(
          relativePath,
          `mirror body drifted from the canonical ${canonicalRelative} — keep the two in sync`,
        );
      }
    }
  }

  notes.push(`zcode-skill ${dirName}`);
}

// ---------------------------------------------------------------------------------------
// In-app slash-command pack (`src-tauri/commands/*.md`).
//
// These ARE loaded by the app: `agent_commands.rs` embeds each file with `include_str!`
// and seeds it into `<data_dir>/commands` on first run. Two failures here are silent,
// which is exactly why they are checked:
//
//   * a body over the cap is TRUNCATED by `parse_command`, so a runbook quietly loses its
//     final steps while still appearing in the menu and still "working";
//   * an `inject:` key outside the allowlist makes `parse_command` reject the whole file,
//     so the command vanishes from the menu with only a load error to explain it.
// ---------------------------------------------------------------------------------------

const COMMAND_PACK_ROOT = "src-tauri/commands";
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
// Mirrors `agent_commands::INJECTABLE_CONTEXT_KEYS`. The cross-check below extracts the
// Rust list and fails on divergence, so this copy is checked, not hand-synced.
const INJECTABLE_CONTEXT_KEYS = new Set([
  "current_database",
  "bound_connection",
  "active_tab_sql",
  "selected_table",
  "schema_summary",
  "checkpoint_list",
]);

// Declared after both mirrored constants so the cross-check sees real values; any
// divergence from the Rust declarations is reported like any other contract violation.
crossCheckRustConstants(report);

const commandPackFiles = listDir(COMMAND_PACK_ROOT)
  .filter((entry) => entry.endsWith(".md"))
  .sort();

if (commandPackFiles.length === 0) {
  process.stdout.write(
    `No built-in command pack at ${COMMAND_PACK_ROOT} — skipping command checks.\n`,
  );
}

for (const file of commandPackFiles) {
  const relativePath = `${COMMAND_PACK_ROOT}/${file}`;
  const { fields, body, hasFrontmatter, multilineKeys } = parseFrontmatter(
    readFileSync(relativePath, "utf8"),
  );
  const expectedName = file.replace(/\.md$/, "");

  if (!hasFrontmatter) {
    report(relativePath, "command has no `---` frontmatter block");
    continue;
  }

  // Same single-line rule as the skills: the Rust parser reads only the first line of a
  // scalar, so a wrapped description loses everything after the wrap.
  if (multilineKeys.has("description")) {
    report(
      relativePath,
      "`description:` spans multiple lines — the runtime parser reads only the first line; " +
        "keep it on one line",
    );
  }

  const declaredName = typeof fields.name === "string" ? fields.name : "";
  if (!declaredName) {
    report(relativePath, "frontmatter is missing `name:`");
  } else if (declaredName !== expectedName) {
    report(
      relativePath,
      `\`name: ${declaredName}\` does not match the file name — a mismatch silently renames ` +
        "the command, because the file stem is only a fallback",
    );
  } else if (!COMMAND_NAME_PATTERN.test(declaredName)) {
    report(
      relativePath,
      `\`${declaredName}\` is not a valid command name; use lowercase letters, digits, \`-\` or \`_\``,
    );
  }

  if (typeof fields.description !== "string" || !fields.description.trim()) {
    report(relativePath, "frontmatter is missing `description:` (the command cannot load)");
  }

  if (body.length > MAX_COMMAND_BODY_CHARS) {
    report(
      relativePath,
      `body is ${body.length} chars, over the ${MAX_COMMAND_BODY_CHARS}-char cap — it is ` +
        "truncated at runtime, so the runbook loses its final steps; move detail into a skill",
    );
  }

  const argumentHint = fields["argument-hint"] ?? fields.argument_hint;
  const hasHint = typeof argumentHint === "string" && argumentHint.trim().length > 0;
  if (hasHint && !body.includes("$ARGUMENTS")) {
    report(
      relativePath,
      "declares `argument-hint:` but the body never uses `$ARGUMENTS` — anything the user " +
        "types after the command name is dropped",
    );
  }

  const rawInject = fields.inject ?? "";
  for (const key of Array.isArray(rawInject) ? rawInject : inlineList(rawInject)) {
    if (!INJECTABLE_CONTEXT_KEYS.has(key)) {
      report(
        relativePath,
        `\`inject: ${key}\` is not an injectable context key — the app rejects the whole ` +
          "command file, so it never appears in the menu",
      );
    }
  }

  const rawTools = fields["allowed-tools"] ?? fields.allowed_tools ?? [];
  const commandTools = Array.isArray(rawTools) ? rawTools : inlineList(rawTools);
  if (commandTools.length > MAX_COMMAND_ALLOWED_TOOLS) {
    report(
      relativePath,
      `${commandTools.length} allowed-tools entries, over the ${MAX_COMMAND_ALLOWED_TOOLS} cap`,
    );
  }
  for (const tool of commandTools) {
    if (!toolNames.has(tool)) {
      report(relativePath, `allowed-tools names an unknown tool: "${tool}"`);
    }
  }

  notes.push(
    `command pack ${expectedName}: ${body.length} body chars` +
      (commandTools.length ? `, tools=[${commandTools.join(", ")}]` : ""),
  );
}

for (const note of notes) process.stdout.write(`  ok  ${note}\n`);

if (problems.length > 0) {
  process.stderr.write(`\nAgent skill contract violations (${problems.length}):\n`);
  for (const problem of problems) process.stderr.write(`  FAIL  ${problem}\n`);
  process.exit(1);
}

process.stdout.write(
  `\nAll ${skillDirs.length} built-in skills and ${commandPackFiles.length} slash commands ` +
    "satisfy the agent contract.\n",
);
