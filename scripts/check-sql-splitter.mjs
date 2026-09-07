import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const repoRoot = process.cwd();
const fixturesPath = path.join(repoRoot, "fixtures", "sql_statement_splitter_cases.json");
const sourcePath = path.join(repoRoot, "src", "utils", "sqlStatements.ts");
const tempModulePath = path.join(repoRoot, ".tmp-sql-statements-check.mjs");

const fixtures = JSON.parse(await fs.readFile(fixturesPath, "utf8"));
const tsSource = await fs.readFile(sourcePath, "utf8");
const transpiled = ts.transpileModule(tsSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020,
  },
});

await fs.writeFile(tempModulePath, transpiled.outputText, "utf8");

try {
  const moduleUrl = pathToFileURL(tempModulePath).href;
  const { splitSqlStatements } = await import(moduleUrl);

  for (const fixture of fixtures) {
    const actual = splitSqlStatements(fixture.sql);
    assert.deepStrictEqual(
      actual,
      fixture.expected,
      `splitSqlStatements mismatch for fixture "${fixture.name}"`,
    );
  }

  process.stdout.write(`Verified ${fixtures.length} shared SQL splitter fixtures against TypeScript implementation.\n`);
} finally {
  await fs.rm(tempModulePath, { force: true });
}
