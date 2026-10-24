// Orchestrates the real-server driver integration harness:
//   node scripts/run-driver-integration.mjs            # core engines
//   node scripts/run-driver-integration.mjs --heavy    # + MSSQL, ScyllaDB
//   node scripts/run-driver-integration.mjs --keep     # leave containers up
//   node scripts/run-driver-integration.mjs --require-all # no skipped engines / no NOT_RUN passes
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sidecarTarget } from "./package-native-sidecars.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(repoRoot, "docker-compose.integration.yml");
const heavy = process.argv.includes("--heavy");
const keep = process.argv.includes("--keep");
const requireAll = process.argv.includes("--require-all");
const nativeDrivers = ["duckdb", "cassandra", "redis", "libsql"];

function ensureNativeSidecars() {
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

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: process.platform === "win32",
    encoding: "utf8",
  });
  if (res.status !== 0) {
    console.error(`\n[driver-integration] command failed: ${cmd} ${args.join(" ")}`);
    if (opts.capture) process.stderr.write(res.stderr || "");
    process.exit(res.status ?? 1);
  }
  return res;
}

console.log("[driver-integration] starting real servers (docker compose)...");
run("docker", ["compose", "-f", composeFile, ...(heavy ? ["--profile", "heavy"] : []), "up", "-d"]);

let cargoStatus = 0;
try {
  const env = {
    ...process.env,
    TABLER_DRIVER_INTEGRATION: "1",
    TABLER_REQUIRE_ALL_ENGINES: requireAll ? "1" : "0",
  };
  if (heavy) {
    env.TABLER_IT_MSSQL = "1";
    env.TABLER_IT_CASSANDRA = "1";
  }
  ensureNativeSidecars();
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
    const res = spawnSync("cargo", args, {
      cwd: path.join(repoRoot, "src-tauri"),
      stdio: "inherit",
      shell: process.platform === "win32",
      env,
    });
    if (res.status !== 0) {
      cargoStatus = res.status ?? 1;
      break;
    }
  }
} finally {
  if (!keep && cargoStatus !== 0) {
    console.log("[driver-integration] tearing containers down after failure...");
    run("docker", ["compose", "-f", composeFile, "down"], { capture: true });
  } else if (!keep) {
    console.log("[driver-integration] cleaning containers...");
    run("docker", ["compose", "-f", composeFile, "down"], { capture: true });
  }
}

if (cargoStatus !== 0) {
  console.error("\n[driver-integration] FAILED — see cargo output above.");
} else {
  console.log("\n[driver-integration] all drivers proved against real servers ✅");
}
process.exit(cargoStatus);
