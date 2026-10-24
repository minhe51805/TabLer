import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  nativeDriverDefinitions,
  sidecarTarget,
  stageNativeSidecar,
} from "../../scripts/package-native-sidecars.mjs";
import { collectBundleFiles, computeBundleDigest } from "../../scripts/build-plugin-registry.mjs";

const pluginsRoot = resolve(process.cwd(), "plugins");

describe("native sidecar packaging", () => {
  it("covers all four native drivers and normalizes platform targets", () => {
    expect(nativeDriverDefinitions().map((definition) => definition.id)).toEqual([
      "duckdb-driver",
      "cassandra-driver",
      "redis-driver",
      "libsql-driver",
    ]);
    expect(sidecarTarget("win32", "x64")).toBe("windows-x86_64");
    expect(sidecarTarget("darwin", "arm64")).toBe("macos-aarch64");
    expect(sidecarTarget("linux", "x64")).toBe("linux-x86_64");
  });

  it("stages the binary at the host path and re-stamps the bundle digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "tabler-native-package-"));
    try {
      const sourceBinary = join(root, "duckdb_sidecar");
      await writeFile(sourceBinary, "native-sidecar-test-binary");
      const target = "linux-x86_64";
      const staged = await stageNativeSidecar({
        definition: nativeDriverDefinitions()[0],
        target,
        sourceBinary,
        pluginsRoot,
        outputRoot: root,
      });
      expect(staged.destinationBinary).toBe(join(root, "duckdb-driver", "bin", target, "duckdb"));
      expect(await readFile(staged.destinationBinary, "utf8")).toBe("native-sidecar-test-binary");

      const manifest = JSON.parse(
        await readFile(join(staged.destinationBundle, "plugin.json"), "utf8"),
      );
      const files = await collectBundleFiles(staged.destinationBundle);
      expect(manifest.integrity.digest).toBe(staged.digest);
      expect(computeBundleDigest(manifest, files)).toBe(staged.digest);
      expect(files.map((file) => file.path)).toContain(`bin/${target}/duckdb`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
