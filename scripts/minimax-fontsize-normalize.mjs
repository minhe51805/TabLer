/*
 * MiniMax font-size normalization — snap hardcoded font sizes to the token scale
 * ------------------------------------------------------------------------------
 * The legacy stylesheets hardcode font-size with ~20 distinct values (8.5px,
 * 9px, 10px, 10.5px, 11px, 11.5px, 12px, 13px, 14px, 15px, 16px, 18px, 19px,
 * 20px, 28px) plus a wide spread of rem values (0.42rem .. 1.24rem). With no
 * shared type scale, some labels render tiny (~7px in the ERD/fintech cluster)
 * while neighbouring titles jump to 18-28px — the "chỗ nhỏ chỗ to bất thường"
 * the user reported.
 *
 * This codemod snaps every literal font-size to the nearest MiniMax type token
 * (by absolute px distance) so the UI uses a single, consistent scale:
 *
 *   --mm-fs-micro:      11px   (small uppercase labels / badges)
 *   --mm-fs-caption:    12px   (captions / meta)
 *   --mm-fs-small:      13px   (secondary body / list rows)
 *   --mm-fs-body:       14px   (body)
 *   --mm-fs-subheading: 16px   (section / card titles)
 *   --mm-fs-heading:    24px   (page headings)
 *   --mm-fs-display:    30px   (display)
 *
 * Safety / idempotency:
 *   - Only literal px and rem font-size values are touched.
 *   - var(), clamp(), calc(), inherit, %, em, keywords are LEFT ALONE
 *     (clamp() is responsive-by-design; var() is already tokenized).
 *   - Re-running is a no-op once values are tokens.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readdirSync } from "node:fs";

const STYLE_DIR = "src/styles";

/* Token scale in px -> CSS variable name. */
const SCALE = [
  { px: 11, token: "var(--mm-fs-micro)" },
  { px: 12, token: "var(--mm-fs-caption)" },
  { px: 13, token: "var(--mm-fs-small)" },
  { px: 14, token: "var(--mm-fs-body)" },
  { px: 16, token: "var(--mm-fs-subheading)" },
  { px: 24, token: "var(--mm-fs-heading)" },
  { px: 30, token: "var(--mm-fs-display)" },
];

function snap(px) {
  let best = SCALE[0];
  let bestDist = Math.abs(px - best.px);
  for (const s of SCALE) {
    const d = Math.abs(px - s.px);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

/* Build the file list: every src/styles/*.css EXCEPT the token source itself
 * (we must not rewrite the --mm-fs-* definitions) plus App.css / index.css. */
function listFiles() {
  const files = [];
  for (const name of readdirSync(STYLE_DIR)) {
    if (!name.endsWith(".css")) continue;
    if (name === "minimax-design-system.css") continue;
    files.push(`${STYLE_DIR}/${name}`);
  }
  for (const extra of ["src/App.css", "src/index.css"]) {
    if (existsSync(extra)) files.push(extra);
  }
  return files;
}

/* Match `font-size: <value>;` — capture the value up to ; or }. */
const FONT_SIZE_RE = /font-size:\s*([^;}]+)/g;
/* A single px or rem numeric literal. */
const PX_RE = /^(-?\d*\.?\d+)px$/;
const REM_RE = /^(-?\d*\.?\d+)rem$/;

function normalize(src, mapping) {
  return src.replace(FONT_SIZE_RE, (full, rawValue) => {
    const value = rawValue.trim();

    // Skip anything that isn't a bare px/rem literal: var(), clamp(), calc(),
    // %, em, inherit, keywords, multi-token shorthands, etc.
    if (/var\(|clamp\(|calc\(|%|\binherit\b|\bem\b|\bsmaller\b|\blarger\b/.test(value)) {
      return full;
    }

    let px = null;
    let m = value.match(PX_RE);
    if (m) px = parseFloat(m[1]);
    else {
      m = value.match(REM_RE);
      if (m) px = parseFloat(m[1]) * 16;
    }
    if (px === null || Number.isNaN(px)) return full;

    const target = snap(px);
    const key = `${value} -> ${target.token}`;
    mapping.set(key, (mapping.get(key) || 0) + 1);
    return `font-size: ${target.token}`;
  });
}

let grand = 0;
const globalMap = new Map();

for (const file of listFiles()) {
  const src = readFileSync(file, "utf8");
  const mapping = new Map();
  const out = normalize(src, mapping);
  let count = 0;
  for (const v of mapping.values()) count += v;
  if (out !== src) {
    writeFileSync(file, out, "utf8");
  }
  grand += count;
  console.log(`${file}: ${count} font-size declarations normalized`);
  for (const [k, v] of [...mapping.entries()].sort()) {
    console.log(`    ${k}  ×${v}`);
    globalMap.set(k, (globalMap.get(k) || 0) + v);
  }
}

console.log(`\n── Global value → token mapping (${grand} total) ──`);
for (const [k, v] of [...globalMap.entries()].sort()) {
  console.log(`  ${k}  ×${v}`);
}
