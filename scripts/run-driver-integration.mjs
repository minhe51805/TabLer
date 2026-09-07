// Orchestrates the real-server driver integration harness:
//   node scripts/run-driver-integration.mjs            # core engines
//   node scripts/run-driver-integration.mjs --heavy    # + MSSQL, ScyllaDB
//   node scripts/run-driver-integration.mjs --keep     # leave containers up
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(repoRoot, "docker-compose.integration.yml");
const heavy = process.argv.includes("--heavy");
const keep = process.argv.includes("--keep");

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
run("docker", [
  "compose",
  "-f",
  composeFile,
  ...(heavy ? ["--profile", "heavy"] : []),
  "up",
  "-d",
  "--wait",
]);

let cargoStatus = 0;
try {
  const env = { ...process.env, TABLER_DRIVER_INTEGRATION: "1" };
  if (heavy) {
    env.TABLER_IT_MSSQL = "1";
    env.TABLER_IT_CASSANDRA = "1";
  }
  const res = spawnSync(
    "cargo",
    ["test", "--test", "driver_integration"],
    { cwd: path.join(repoRoot, "src-tauri"), stdio: "inherit", shell: process.platform === "win32", env },
  );
  cargoStatus = res.status ?? 1;
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
