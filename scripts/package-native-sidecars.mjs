import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectBundleFiles, computeBundleDigest } from "./build-plugin-registry.mjs";

const DEFINITIONS = [
  { id: "duckdb-driver", driverId: "duckdb", binary: "duckdb_sidecar", feature: "duckdb-sidecar" },
  {
    id: "cassandra-driver",
    driverId: "cassandra",
    binary: "cassandra_sidecar",
    feature: "cassandra-sidecar",
  },
  { id: "redis-driver", driverId: "redis", binary: "redis_sidecar", feature: "redis-sidecar" },
  { id: "libsql-driver", driverId: "libsql", binary: "libsql_sidecar", feature: "libsql-sidecar" },
];

export function nativeDriverDefinitions() {
  return DEFINITIONS.map((definition) => ({ ...definition }));
}

export function sidecarTarget(platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform;
  const normalizedArch = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch;
  return `${os}-${normalizedArch}`;
}

export async function stageNativeSidecar({
  definition,
  target,
  sourceBinary,
  pluginsRoot,
  outputRoot,
}) {
  const sourceBundle = join(pluginsRoot, definition.id);
  const destinationBundle = join(outputRoot, definition.id);
  await cp(sourceBundle, destinationBundle, { recursive: true });
  const executableName = `${definition.driverId}${target.startsWith("windows-") ? ".exe" : ""}`;
  const destinationBinary = join(destinationBundle, "bin", target, executableName);
  await mkdir(join(destinationBundle, "bin", target), { recursive: true });
  await cp(sourceBinary, destinationBinary);

  const manifestPath = join(destinationBundle, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const files = await collectBundleFiles(destinationBundle);
  manifest.integrity = {
    algorithm: "sha256",
    digest: computeBundleDigest(manifest, files),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { destinationBundle, destinationBinary, digest: manifest.integrity.digest };
}

async function main() {
  const pluginsRoot = fileURLToPath(new URL("../plugins/", import.meta.url));
  const outputRoot = fileURLToPath(new URL("../dist-plugins/", import.meta.url));
  const target = process.env.TABLER_SIDE_TARGET ?? sidecarTarget();
  const results = [];
  for (const definition of DEFINITIONS) {
    const build = spawnSync(
      "cargo",
      [
        "build",
        "--release",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--bin",
        definition.binary,
        "--features",
        definition.feature,
      ],
      { stdio: "inherit", shell: process.platform === "win32" },
    );
    if (build.status !== 0) {
      throw new Error(`${definition.binary} build failed with status ${build.status}`);
    }
    const sourceBinary = join(
      "src-tauri",
      "target",
      "release",
      `${definition.binary}${process.platform === "win32" ? ".exe" : ""}`,
    );
    const staged = await stageNativeSidecar({
      definition,
      target,
      sourceBinary,
      pluginsRoot,
      outputRoot,
    });
    results.push({ id: definition.id, target, ...staged });
    console.log(`  [ready] ${definition.id} -> bin/${target}/${definition.driverId}`);
  }
  await writeFile(
    join(outputRoot, "native-sidecars-manifest.json"),
    `${JSON.stringify({ target, packages: results }, null, 2)}\n`,
    "utf8",
  );
  console.log(`\n  ${results.length} native sidecar plugin(s) staged for ${target}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
