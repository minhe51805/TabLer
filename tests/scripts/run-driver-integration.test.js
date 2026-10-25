import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../scripts/run-driver-integration.mjs";

describe("driver integration runner", () => {
  it("passes argv through paths and arguments containing spaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "tabler driver runner-"));
    try {
      const script = join(root, "argv echo.mjs");
      await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
      const result = run(process.execPath, [script, "argument with spaces", "đồng bộ"], {
        capture: true,
      });
      expect(JSON.parse(result.stdout)).toEqual(["argument with spaces", "đồng bộ"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses shell-free execution and removes compose volumes during cleanup", async () => {
    const source = await readFile(
      resolve(process.cwd(), "scripts/run-driver-integration.mjs"),
      "utf8",
    );
    expect(source).toContain("shell: false");
    expect(source).toMatch(/"down",\s*"-v"/);
    expect(source.match(/\.\.\.\(heavy \? \["--profile", "heavy"\] : \[\]\)/g)).toHaveLength(2);
    expect(source).not.toContain('shell: process.platform === "win32"');
  });
});
