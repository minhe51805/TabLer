/**
 * Applies eslint suggestions for react-hooks/exhaustive-deps ("Update the
 * dependencies array to be: [...]") using the exact byte ranges computed by
 * the rule from the AST — no bracket guessing.
 *
 * Usage: node scripts/apply-eslint-suggestions.mjs <eslint-json-report>
 */
import fs from 'node:fs';

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('usage: node scripts/apply-eslint-suggestions.mjs <report.json>');
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

let applied = 0;
let skippedOverlap = 0;
const perFile = [];

for (const file of report) {
  const fixes = [];
  for (const m of file.messages) {
    if (m.ruleId !== 'react-hooks/exhaustive-deps') continue;
    const sug = (m.suggestions ?? []).find((s) =>
      s.desc.startsWith('Update the dependencies array to be:'),
    );
    if (sug) fixes.push({ range: sug.fix.range, text: sug.fix.text, line: m.line });
  }
  if (!fixes.length) continue;

  // sort descending by start so earlier edits don't shift later offsets;
  // dedupe identical ranges; skip overlaps via lastStart watermark
  fixes.sort((a, b) => b.range[0] - a.range[0] || b.range[1] - a.range[1]);
  const seen = new Set();
  const uniq = [];
  for (const f of fixes) {
    const key = `${f.range[0]}:${f.range[1]}:${f.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(f);
  }

  const source = fs.readFileSync(file.filePath, 'utf8');
  let out = source;
  let lastStart = Number.POSITIVE_INFINITY;
  let appliedHere = 0;
  for (const f of uniq) {
    if (f.range[1] > lastStart) {
      skippedOverlap++;
      continue;
    }
    out = out.slice(0, f.range[0]) + f.text + out.slice(f.range[1]);
    lastStart = f.range[0];
    appliedHere++;
  }
  if (!appliedHere) continue;
  fs.writeFileSync(file.filePath, out);
  applied += appliedHere;
  perFile.push(`${String(appliedHere).padStart(3)} ${file.filePath.replace(/.*src[\\/]/, 'src/')}`);
}

console.log(`Applied: ${applied}, skipped (overlap): ${skippedOverlap}`);
for (const l of perFile) console.log(l);
