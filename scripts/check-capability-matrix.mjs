import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const sourcePath = path.join(repoRoot, "src-tauri", "src", "database", "capabilities.rs");
const baselinePath = path.join(repoRoot, "scripts", "capability-matrix-baseline.json");
const writeBaseline = process.argv.includes("--write");

// Positional order of the capability cells inside each `profile(...)` call in
// `driver_capabilities` (after database_type/key/label/tier).
const CAPABILITY_KEYS = [
  "connect",
  "query",
  "prepared_parameters",
  "query_cancellation",
  "pagination",
  "inline_edit",
  "atomic_edit_queue",
  "atomic_csv_import",
  "data_export",
  "explain",
  "schema_edit",
  "backup_restore",
  "administration",
];

// Rank order: a regression is any move to a strictly lower rank.
const RANK = { S: 3, L: 2, U: 1, N: 0 };

const source = fs.readFileSync(sourcePath, "utf8");
const rowPattern =
  /DatabaseType::(\w+)\s*=>\s*profile\(\s*database_type,\s*"([^"]+)",\s*"[^"]+",\s*DriverTier::\w+,\s*([SLUN](?:\s*,\s*[SLUN])*)\s*,\s*&\[/g;

const current = {};
for (const match of source.matchAll(rowPattern)) {
  const [, variant, key, cellsRaw] = match;
  const cells = cellsRaw.split(",").map((cell) => cell.trim());
  if (cells.length !== CAPABILITY_KEYS.length) {
    throw new Error(
      `capabilities.rs: ${variant} ("${key}") has ${cells.length} capability cells, expected ${CAPABILITY_KEYS.length}.`,
    );
  }
  current[key] = Object.fromEntries(CAPABILITY_KEYS.map((name, i) => [name, cells[i]]));
}

const engineCount = Object.keys(current).length;
if (engineCount === 0) {
  throw new Error("capabilities.rs: no profile(...) rows matched; the parser is stale.");
}

if (writeBaseline) {
  fs.writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  console.log(
    `Wrote capability matrix baseline for ${engineCount} engines to ${path.relative(repoRoot, baselinePath)}.`,
  );
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  throw new Error(
    `Missing ${path.relative(repoRoot, baselinePath)}. Generate it with: node scripts/check-capability-matrix.mjs --write`,
  );
}
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

const downgrades = [];
const upgrades = [];
const added = [];
for (const [key, cells] of Object.entries(current)) {
  const baseCells = baseline[key];
  if (!baseCells) {
    added.push(key);
    continue;
  }
  for (const name of CAPABILITY_KEYS) {
    const before = baseCells[name];
    const after = cells[name];
    if (before === undefined || before === after) continue;
    const entry = `${key}.${name}: ${before} -> ${after}`;
    if (RANK[after] < RANK[before]) downgrades.push(entry);
    else upgrades.push(entry);
  }
}
const removed = Object.keys(baseline).filter((key) => !(key in current));

for (const entry of upgrades) {
  console.log(`note: capability upgraded (${entry})`);
}
for (const key of added) {
  console.log(`note: new engine "${key}" is not in the baseline`);
}
if (removed.length > 0) {
  console.log(`note: engines removed from the matrix: ${removed.join(", ")}`);
}
if (upgrades.length > 0 || added.length > 0 || removed.length > 0) {
  console.log("Regenerate the baseline with: node scripts/check-capability-matrix.mjs --write");
}

if (downgrades.length > 0) {
  throw new Error(
    `Capability matrix regressions detected:\n${downgrades.map((d) => `  ${d}`).join("\n")}`,
  );
}
console.log(`Capability matrix check passed for ${engineCount} engines.`);
