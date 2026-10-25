import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareE2EBinary } from "../../scripts/prepare-e2e-binary.mjs";

describe("E2E binary isolation", () => {
  it("keeps the dedicated binary unchanged when Cargo overwrites the build target", async () => {
    const root = await mkdtemp(join(tmpdir(), "tabler-e2e-binary-"));
    try {
      const sourceBinary = join(root, "tabler.exe");
      const outputBinary = join(root, "nested", "tabler-e2e.exe");
      await writeFile(sourceBinary, "e2e-build");
      await prepareE2EBinary({ sourceBinary, outputBinary });

      await writeFile(sourceBinary, "cargo-test-build");
      expect(await readFile(outputBinary, "utf8")).toBe("e2e-build");
      expect(await readFile(sourceBinary, "utf8")).toBe("cargo-test-build");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
