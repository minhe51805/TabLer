// Orchestrates the real-server driver integration harness:
//   node scripts/run-driver-integration.mjs            # core engines
//   node scripts/run-driver-integration.mjs --heavy    # + MSSQL, ScyllaDB, Greenplum, Vertica
//   node scripts/run-driver-integration.mjs --keep     # leave containers up
//   node scripts/run-driver-integration.mjs --require-all # no skipped engines / no NOT_RUN passes
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { sidecarTarget } from "./package-native-sidecars.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(repoRoot, "docker-compose.integration.yml");
const nativeDrivers = ["duckdb", "cassandra", "redis", "libsql"];

function ensureNativeSidecars(requireAll) {
  const target = sidecarTarget();
  const missing = nativeDrivers.some((driverId) => {
    const executable = `${driverId}${target.startsWith("windows-") ? ".exe" : ""}`;
    return !existsSync(
      path.join(repoRoot, "dist-plugins", `${driverId}-driver`, "bin", target, executable),
    );
  });
  if (missing || requireAll) {
    run("node", ["scripts/package-native-sidecars.mjs"]);
  }
}

export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
    encoding: "utf8",
    env: opts.env ?? process.env,
  });
  if (res.error || res.status !== 0) {
    console.error(`\n[driver-integration] command failed: ${cmd} ${args.join(" ")}`);
    if (res.error) console.error(res.error.message);
    if (opts.capture) process.stderr.write(res.stderr || "");
    throw new Error(`${cmd} exited with status ${res.status ?? 1}`);
  }
  return res;
}

function main() {
  const heavy = process.argv.includes("--heavy");
  const keep = process.argv.includes("--keep");
  const requireAll = process.argv.includes("--require-all");
  let cargoStatus = 0;

  try {
    console.log("[driver-integration] starting real servers (docker compose)...");
    run("docker", [
      "compose",
      "-f",
      composeFile,
      ...(heavy ? ["--profile", "heavy"] : []),
      "up",
      "-d",
    ]);

    const env = {
      ...process.env,
      TABLER_DRIVER_INTEGRATION: "1",
      TABLER_REQUIRE_ALL_ENGINES: requireAll ? "1" : "0",
    };
    if (heavy) {
      env.TABLER_IT_MSSQL = "1";
      env.TABLER_IT_CASSANDRA = "1";
      env.TABLER_IT_GREENPLUM = "1";
      env.TABLER_IT_VERTICA = "1";
    }
    ensureNativeSidecars(requireAll);
    const suites = [
      {
        name: "driver_integration",
        features: "duckdb-driver,cassandra-driver,redis-driver,libsql-driver",
      },
      { name: "engine_matrix_integration", features: null },
      { name: "sidecar_integration", features: null },
    ];
    for (const suite of suites) {
      const args = ["test"];
      if (suite.features) args.push("--features", suite.features);
      args.push("--test", suite.name);
      run("cargo", args, {
        cwd: path.join(repoRoot, "src-tauri"),
        env,
      });
    }
  } catch (error) {
    cargoStatus = 1;
    console.error(`[driver-integration] ${error.message}`);
  } finally {
    if (!keep) {
      try {
        console.log("[driver-integration] cleaning containers and volumes...");
        run(
          "docker",
          ["compose", "-f", composeFile, ...(heavy ? ["--profile", "heavy"] : []), "down", "-v"],
          { capture: true },
        );
      } catch (error) {
        cargoStatus = 1;
        console.error(`[driver-integration] cleanup failed: ${error.message}`);
      }
    }
  }

  if (cargoStatus !== 0) {
    console.error("\n[driver-integration] FAILED — see cargo output above.");
  } else {
    console.log("\n[driver-integration] all selected drivers proved against real servers ✅");
  }
  process.exit(cargoStatus);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
