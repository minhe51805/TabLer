import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Bundle-graph contract: vendor-monaco must never be reachable from the
// entry HTML through static import edges — or through import() calls in
// statically-reached files (main.tsx awaits import("./App") at boot, so
// those targets are boot-loaded too). Files reached ACROSS an import()
// boundary may keep their own import() calls lazy: prefetch, profiler and
// locale loads stay conditional.
//
// Regressions this guards:
//   - shared-helper merge that made main import vendor-monaco (fixed via
//     onlyExplicitManualChunks);
//   - boot-time monaco prefetch firing unconditionally after first paint
//     (moved to useMonacoPrefetchOnWorkspace inside App.tsx).
//
// Run after `npm run build`: `node scripts/check-bundle-graph.mjs`

const repoRoot = process.cwd();
const htmlPath = path.join(repoRoot, "dist", "index.html");
const assetsDir = path.join(repoRoot, "dist", "assets");

const html = fs.readFileSync(htmlPath, "utf8");

const entryFiles = new Set();
for (const match of html.matchAll(/<script[^>]*src="\.\/(assets\/[^"]+)"/g)) {
  entryFiles.add(match[1]);
}
for (const match of html.matchAll(/<link[^>]*modulepreload[^>]*href="\.\/(assets\/[^"]+)"/g)) {
  entryFiles.add(match[1]);
}
assert.ok(entryFiles.size > 0, "index.html lists no script/preload entries");

const STATIC_EDGE = /(?:from|import)\s*"\.\/([^"]+\.js)"/g;
const DYNAMIC_EDGE = /import\s*\(\s*"\.\/([^"]+\.js)"\s*\)/g;

const visited = new Set();
const offenders = [];
const stack = [];

function push(absPath, staticDepth) {
  if (!visited.has(absPath)) {
    visited.add(absPath);
    stack.push([absPath, staticDepth]);
  }
}

for (const rel of entryFiles) push(path.join(repoRoot, "dist", rel), true);

while (stack.length) {
  const [file, staticDepth] = stack.pop();
  if (!fs.existsSync(file)) continue;
  const rel = path.relative(repoRoot, file);
  if (path.basename(file).startsWith("vendor-monaco")) {
    offenders.push(rel);
    continue;
  }
  const code = fs.readFileSync(file, "utf8");
  for (const match of code.matchAll(STATIC_EDGE)) {
    push(path.join(assetsDir, match[1]), staticDepth);
  }
  if (staticDepth) {
    for (const match of code.matchAll(DYNAMIC_EDGE)) {
      push(path.join(assetsDir, match[1]), false);
    }
  }
}

assert.deepEqual(
  offenders,
  [],
  `vendor-monaco is boot-reachable:\n  ${offenders.join("\n  ")}\n` +
    "This drags ~3.9 MB of editor into the boot path. Keep Monaco behind a lazy boundary.",
);

let eagerBytes = 0;
for (const file of visited) {
  if (fs.existsSync(file)) eagerBytes += fs.statSync(file).size;
}

console.log(
  `Bundle graph OK — ${visited.size} boot-reachable file(s), ` +
    `${(eagerBytes / 1024).toFixed(0)} KB loaded before first paint, vendor-monaco lazy.`,
);
