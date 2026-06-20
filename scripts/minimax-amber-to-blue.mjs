/*
 * MiniMax amber → Apple-blue migration
 * ------------------------------------
 * P1 of the TablePro redesign drops the legacy MiniMax amber accent entirely in
 * favour of Apple blue #007AFF. The token layers (minimax-design-system.css +
 * MINIMAX_THEME in theme-engine.ts) are already reskinned, but ~189 hardcoded
 * amber literals remain scattered across component stylesheets as either:
 *   - hex  #C37D0D  (amber)            -> #007AFF
 *   - hex  #E59121  (amber hover)      -> #0A6CFF
 *   - rgba(195, 125, 13, A)            -> rgba(0, 122, 255, A)   (alpha preserved)
 *
 * This codemod is value-agnostic on alpha (any alpha is preserved) and only
 * touches the three amber color signatures, so it is idempotent and safe to
 * re-run. var(--*) references and all non-amber colors are left untouched.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";

const STYLE_DIR = "src/styles";

function listFiles() {
  const files = [];
  for (const name of readdirSync(STYLE_DIR)) {
    if (!name.endsWith(".css")) continue;
    // The token source is already hand-reskinned; skip to avoid clobbering the
    // few intentional amber aliases left for backward compat.
    if (name === "minimax-design-system.css") continue;
    files.push(`${STYLE_DIR}/${name}`);
  }
  for (const extra of ["src/App.css", "src/index.css"]) {
    if (existsSync(extra)) files.push(extra);
  }
  return files;
}

/* rgba/rgb amber triplet -> Apple-blue triplet, preserving alpha + spacing. */
const RGBA_RE = /rgba?\(\s*195\s*,\s*125\s*,\s*13\s*(,\s*[\d.]+\s*)?\)/gi;
/* amber hexes (case-insensitive). */
const HEX_AMBER_RE = /#C37D0D\b/gi;
const HEX_AMBER_HOVER_RE = /#E59121\b/gi;

function migrate(src, c) {
  let out = src.replace(RGBA_RE, (full, alpha) => {
    c.rgba++;
    return alpha ? `rgba(0, 122, 255${alpha.replace(/\s+/g, " ").replace(/\s*$/, "")})` : "rgb(0, 122, 255)";
  });
  out = out.replace(HEX_AMBER_RE, () => {
    c.hex++;
    return "#007AFF";
  });
  out = out.replace(HEX_AMBER_HOVER_RE, () => {
    c.hexHover++;
    return "#0A6CFF";
  });
  return out;
}

let grand = 0;
for (const file of listFiles()) {
  const src = readFileSync(file, "utf8");
  const c = { rgba: 0, hex: 0, hexHover: 0 };
  const out = migrate(src, c);
  const total = c.rgba + c.hex + c.hexHover;
  if (out !== src) writeFileSync(file, out, "utf8");
  grand += total;
  if (total > 0) console.log(`${file}: ${total} amber→blue`, c);
}
console.log(`TOTAL: ${grand} amber literals migrated to Apple blue`);
