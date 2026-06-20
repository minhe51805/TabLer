/*
 * MiniMax light migration (Option A) — v2, value-agnostic
 * --------------------------------------------------------
 * The legacy stylesheets were authored for a dark "fintech glassmorphism"
 * look. Option A makes the MiniMax LIGHT design the single global theme, so
 * every hardcoded dark surface / fintech-accent / light-on-dark text now
 * fights the design system.
 *
 * v1 enumerated exact RGB triplets and was therefore INCOMPLETE: these files
 * use dozens of distinct dark shades, which left ~350 dark literals behind and
 * produced half-converted gradients (one stop migrated, the neighbouring stop
 * still dark). The fix is value-agnostic: classify every colour literal by
 * (a) perceived luminance, (b) the CSS property it sits in, and (c) the
 * selector it belongs to, then map to the MiniMax token layer. This guarantees
 * completeness regardless of the exact shade.
 *
 * Decision table (per colour literal):
 *   - PRESERVE brand/semantic colours exactly:
 *       charcoal #111827, text #3F3F3F / #707071, amber #C37D0D,
 *       success #16A34A, warning #FFA500/#FA500, error #E6483D,
 *       danger #f87171, insert-green #28c878, pure black, status rgba.
 *   - Fintech ACCENT families (teal / cyan / blue / indigo / emerald, hex+rgba)
 *       -> amber (#C37D0D, alpha preserved).
 *   - WHITE: only meaningful in `color` (-> text token) and `border*`
 *       (-> --mm-border). Left alone as a background / box-shadow highlight.
 *   - DARK / MID colours, by property:
 *       background*  -> light surface (by alpha) | charcoal scrim for backdrops
 *       color        -> text token only when light-on-light (else dark text kept)
 *       border / outline -> --mm-border
 *       fill         -> --mm-surface-1   |   stroke -> --mm-border
 *       box-shadow / text-shadow / other -> left (dark shadows are fine on light)
 *
 * The script is idempotent: it only touches literal rgb()/rgba()/hex colours,
 * never `var(--*)` references, so re-running it is safe.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const FILES = [
  "src/styles/title-row-layout-tweak-for-badges.css",
  "src/styles/quick-switcher.css",
  "src/styles/fintech-glassmorphism-design-system.css",
  "src/styles/ai-settings.css",
  "src/styles/ai-settings-modal.css",
  "src/styles/filter-presets-operators.css",
  "src/styles/lazy-overlays.css",
  "src/styles/boot-failure.css",
  "src/styles/explain-diagram.css",
];

/* Brand + semantic colours kept exactly as-is (alpha-agnostic key "r,g,b"). */
const PRESERVE_RGB = new Set([
  "17,24,39",     // #111827 charcoal brand
  "63,63,63",     // #3F3F3F text-primary
  "112,112,113",  // #707071 text-muted
  "195,125,13",   // #C37D0D amber
  "22,163,74",    // #16A34A success
  "255,165,0",    // #FFA500 warning
  "250,80,0",     // #FA5000 warning alt
  "230,72,61",    // #E6483D error
  "248,113,113",  // #f87171 danger red
  "40,200,120",   // #28c878 insert green
]);

/* Hex literals kept exactly (lowercased). Dark button-text hexes are NOT here
 * because dark `color:` is left untouched anyway. */
const PRESERVE_HEX = new Set([
  "#111827", "#3f3f3f", "#707071", "#c37d0d",
  "#16a34a", "#ffa500", "#fa5000", "#e6483d",
  "#f87171", "#28c878",
]);

/* Fintech accent families -> amber. */
const ACCENT_HEX = new Set([
  "#00d4aa", "#7aa2ff", "#00e6b8", "#00cca3", "#00b894", "#00d4a", "#00c853",
]);
const ACCENT_RGB = new Set([
  "0,212,170", "0,200,83", "34,211,238", "99,102,241", "122,162,255",
  "142,174,254", "0,168,232", "16,185,129", "45,212,191", "53,230,211",
  "64,230,193", "65,219,199", "96,165,250", "110,168,255", "88,211,155",
  "143,211,255", "118,255,3", "40,230,193", "33,212,253", "56,189,248",
]);

function fmtA(a) {
  if (a >= 1) return "1";
  const s = a.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" ? "0" : s;
}

function parseColor(raw) {
  const lower = raw.toLowerCase();
  if (lower[0] === "#") {
    let h = lower.slice(1);
    if (h.length === 3) h = h.split("").map((c) => c + c).join("") + "ff";
    else if (h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("") + h[3] + h[3];
    else if (h.length === 6) h += "ff";
    else if (h.length !== 8) return null;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = parseInt(h.slice(6, 8), 16) / 255;
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return { r, g, b, a };
  }
  const nums = lower.match(/[\d.]+/g);
  if (!nums || nums.length < 3) return null;
  if (raw.includes("%")) return null; // skip percentage rgb (rare / not present)
  const r = +nums[0], g = +nums[1], b = +nums[2];
  const a = nums.length >= 4 ? +nums[3] : 1;
  if ([r, g, b].some((n) => Number.isNaN(n) || n > 255)) return null;
  return { r, g, b, a };
}

const isBorder = (p) => !!p && (p.startsWith("border") || p === "outline" || p === "outline-color");
const isColorProp = (p) => p === "color";
const isBackground = (p) => !!p && p.startsWith("background");

function darkBgSurface(a) {
  if (a >= 0.9) return "var(--mm-surface-0)";
  if (a >= 0.6) return "var(--mm-surface-1)";
  return "var(--mm-surface-2)";
}

function classifyColor(raw, prop, sel, c) {
  const lower = raw.toLowerCase();

  if (ACCENT_HEX.has(lower)) { c.accentHex++; return "#C37D0D"; }
  if (PRESERVE_HEX.has(lower)) return raw;

  const col = parseColor(raw);
  if (!col) return raw;
  const { r, g, b, a } = col;
  const key = `${r},${g},${b}`;

  if (PRESERVE_RGB.has(key)) return raw;
  if (ACCENT_RGB.has(key)) { c.accentRgba++; return `rgba(195, 125, 13, ${fmtA(a)})`; }

  // pure white
  if (r === 255 && g === 255 && b === 255) {
    if (isBorder(prop)) { c.border++; return "var(--mm-border)"; }
    if (isColorProp(prop)) { c.colorText++; return "var(--text-primary)"; }
    return raw; // subtle white bg / inset highlight — harmless on light
  }
  // pure black -> shadows etc, leave
  if (r === 0 && g === 0 && b === 0) return raw;

  const L = 0.299 * r + 0.587 * g + 0.114 * b;

  if (isBorder(prop)) { c.border++; return "var(--mm-border)"; }

  if (isColorProp(prop)) {
    if (L > 185) { c.colorText++; return "var(--text-primary)"; } // light-on-light -> dark text
    return raw; // dark text is correct on a light theme
  }

  if (isBackground(prop)) {
    if (/(backdrop|overlay|scrim)/.test(sel) && L < 140) {
      c.scrim++;
      return `rgba(17, 24, 39, ${fmtA(a)})`; // MiniMax charcoal dimming scrim
    }
    if (L < 115) { c.darkBg++; return darkBgSurface(a); }
    if (L <= 200) { c.midBg++; return "var(--mm-surface-2)"; }
    return raw; // already-light background
  }

  if (prop === "fill") {
    if (L < 140) { c.fillStroke++; return "var(--mm-surface-1)"; }
    return raw;
  }
  if (prop === "stroke") { c.fillStroke++; return "var(--mm-border)"; }

  // box-shadow / text-shadow / other props: leave (dark shadows are fine)
  return raw;
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
const PROP_RE = /^\s*(--[\w-]+|[a-zA-Z-]+)\s*:/;

function migrate(src, c) {
  const lines = src.split("\n");
  let currentProp = null;
  let currentSel = "";
  let selBuf = "";

  const out = lines.map((line) => {
    // selector / block bookkeeping
    if (line.includes("{")) {
      currentSel = (selBuf + " " + line.split("{")[0]).toLowerCase();
      selBuf = "";
      currentProp = null;
    } else if (line.includes("}")) {
      currentSel = "";
      selBuf = "";
      currentProp = null;
    } else if (currentProp === null && /,\s*$/.test(line) && !line.includes(":")) {
      selBuf += " " + line; // multi-line selector list continuation
    }

    const m = line.match(PROP_RE);
    if (m) currentProp = m[1].toLowerCase();

    let result = line;
    if (currentProp !== null) {
      result = line.replace(COLOR_RE, (raw) => classifyColor(raw, currentProp, currentSel, c));
    }

    // a terminated declaration clears the active property
    if (line.includes(";")) currentProp = null;

    return result;
  });

  return out.join("\n");
}

let grand = 0;
for (const file of FILES) {
  if (!existsSync(file)) {
    console.log(`${file}: SKIPPED (not found)`);
    continue;
  }
  const src = readFileSync(file, "utf8");
  const c = { accentHex: 0, accentRgba: 0, darkBg: 0, midBg: 0, scrim: 0, colorText: 0, border: 0, fillStroke: 0 };
  const out = migrate(src, c);
  writeFileSync(file, out, "utf8");
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  grand += total;
  console.log(`${file}: ${total} replacements`, c);
}
console.log(`TOTAL: ${grand} replacements`);
