/**
 * Test-discipline ratchet — the "LOC test / code" gate.
 *
 * What it does: measures the test-to-code line ratio across the repo and
 * refuses to let it DROP below the committed baseline. The baseline only moves
 * up (run with `--ratchet` and commit the result), so every PR either holds or
 * improves coverage density — the audit's 13% figure can never regress to 9%.
 *
 * What counts (documented approximation, consistent over time):
 *   code LOC  = non-blank lines in src/**\/*.{ts,tsx} plus non-blank lines in
 *               src-tauri/src/**\/*.rs ABOVE the first `#[cfg(test)]` marker.
 *   test LOC  = non-blank lines in tests/**\/*.{ts,tsx}, e2e/**\/*.{ts,mjs},
 *               plus the portion of each .rs file from its first `#[cfg(test)]`
 *               marker to EOF (inline `mod tests` convention).
 *
 * Usage:
 *   node scripts/check-test-discipline.mjs           # gate (CI + local)
 *   node scripts/check-test-discipline.mjs --ratchet # raise the baseline
 */
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const baselinePath = path.join(repoRoot, "scripts", "test-discipline-baseline.json");
const ratchet = process.argv.includes("--ratchet");

/** Recursively collect files matching `extensions` under `dir`. */
function walk(dir, extensions, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "target" || entry.name === "dist") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, extensions, out);
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/** Non-blank line count. `untilMarker` truncates at the first line containing it. */
function countLines(file, untilMarker = null) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    if (untilMarker !== null && line.includes(untilMarker)) return count;
    if (line.trim().length > 0) count += 1;
  }
  return count;
}

/** Lines from the first `#[cfg(test)]` marker to EOF (Rust inline test module). */
function countTailFromMarker(file, marker) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(marker));
  if (start === -1) return 0;
  let count = 0;
  for (const line of lines.slice(start)) {
    if (line.trim().length > 0) count += 1;
  }
  return count;
}

const codeFiles = [
  ...walk(path.join(repoRoot, "src"), [".ts", ".tsx"]),
  ...walk(path.join(repoRoot, "src-tauri", "src"), [".rs"]),
];
const testFiles = [
  ...walk(path.join(repoRoot, "tests"), [".ts", ".tsx"]),
  ...walk(path.join(repoRoot, "e2e"), [".ts", ".mjs"]),
];

let codeLoc = 0;
let testLoc = 0;
for (const file of codeFiles) {
  if (file.endsWith(".rs")) {
    codeLoc += countLines(file, "#[cfg(test)]");
    testLoc += countTailFromMarker(file, "#[cfg(test)]");
  } else {
    codeLoc += countLines(file);
  }
}
for (const file of testFiles) {
  testLoc += countLines(file);
}

const ratio = codeLoc === 0 ? 0 : testLoc / codeLoc;
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

console.log(
  `test/code LOC ratio: ${(ratio * 100).toFixed(1)}% ` +
    `(test ${testLoc} / code ${codeLoc}; baseline ${(baseline.ratio * 100).toFixed(1)}%)`,
);

if (ratchet) {
  if (ratio > baseline.ratio) {
    baseline.ratio = Number(ratio.toFixed(4));
    baseline.updatedAt = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
    console.log(
      `Baseline ratcheted up to ${(baseline.ratio * 100).toFixed(1)}% — commit the new baseline.`,
    );
  } else {
    console.log("Ratio did not improve; baseline unchanged.");
  }
  process.exit(0);
}

if (ratio + 1e-9 < baseline.ratio) {
  console.error(
    `\nTest-discipline gate FAILED: ratio dropped ${((baseline.ratio - ratio) * 100).toFixed(2)}pp ` +
      `below the baseline. Add tests with this change, or raise the baseline only by shipping tests ` +
      `first (--ratchet).`,
  );
  process.exit(1);
}
console.log("Test-discipline gate passed.");
