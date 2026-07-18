import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const runtime = path.join(root, ".artifacts", "e2e", "runtime");
fs.rmSync(runtime, { recursive: true, force: true });
fs.mkdirSync(runtime, { recursive: true });

const env = {
  ...process.env,
  TABLER_DATA_DIR: runtime,
  TABLER_E2E_DATA_DIR: runtime,
  WEBVIEW2_USER_DATA_FOLDER: path.join(runtime, "webview2"),
};

const managedProcessNames = new Set([
  "tauri-driver",
  "tauri-driver.exe",
  "msedgedriver",
  "msedgedriver.exe",
  "WebKitWebDriver",
  "tabler",
  "tabler.exe",
]);

function processSnapshot() {
  const result = process.platform === "win32"
    ? spawnSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}' -f $_.ProcessId,$_.Name }",
      ], { encoding: "utf8" })
    : spawnSync("ps", ["-eo", "pid=,comm="], { encoding: "utf8" });
  if (result.status !== 0) return new Map();

  const processes = new Map();
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    const match = process.platform === "win32"
      ? line.trim().match(/^(\d+)\|(.+)$/)
      : line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const name = path.basename(match[2].trim());
    if (managedProcessNames.has(name)) processes.set(Number(match[1]), name);
  }
  return processes;
}

const processesBeforeRun = processSnapshot();

function cleanupRunProcesses() {
  const created = [...processSnapshot()].filter(([pid]) => !processesBeforeRun.has(pid));
  for (const [pid, name] of created) {
    if (!processSnapshot().has(pid)) continue;
    const result = process.platform === "win32"
      ? spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" })
      : spawnSync("kill", ["-TERM", String(pid)], { encoding: "utf8" });
    if (result.status !== 0 && processSnapshot().has(pid)) {
      process.stderr.write(`Could not stop E2E process ${name} (${pid}) gracefully.\n`);
    }
  }

  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!created.some(([pid]) => processSnapshot().has(pid))) break;
    Atomics.wait(sleeper, 0, 0, 100);
  }
  if (process.platform !== "win32") {
    for (const [pid] of created) {
      if (processSnapshot().has(pid)) {
        spawnSync("kill", ["-KILL", String(pid)], { encoding: "utf8" });
      }
    }
  }

  const remaining = processSnapshot();
  const cleanupLines = created.map(([pid, name]) =>
    `${remaining.has(pid) ? "failed" : "stopped"} pid=${pid} process=${name}`,
  );
  fs.writeFileSync(
    path.join(root, ".artifacts", "e2e", "cleanup.log"),
    `${cleanupLines.join("\n")}${cleanupLines.length ? "\n" : "no managed processes remained\n"}`,
  );
}

function runAndCapture(command, args, logName) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  fs.writeFileSync(path.join(root, ".artifacts", "e2e", logName), output);
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return result;
}

function finish(status) {
  cleanupRunProcesses();
  const appLog = path.join(runtime, "logs", "tabler.jsonl");
  if (fs.existsSync(appLog)) {
    fs.copyFileSync(appLog, path.join(root, ".artifacts", "e2e", "app.log.jsonl"));
  }
  fs.rmSync(runtime, { recursive: true, force: true });
  process.exit(status ?? 1);
}

const prepare = runAndCapture(
  "cargo",
  [
    "run",
    "--quiet",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--features",
    "e2e",
    "--example",
    "prepare_e2e_fixtures",
  ],
  "fixture.log",
);
if (prepare.status !== 0) finish(prepare.status);

const wdio = runAndCapture(
  process.execPath,
  [path.join(root, "node_modules", "@wdio", "cli", "bin", "wdio.js"), "run", "e2e/wdio.conf.mjs"],
  "wdio.log",
);
finish(wdio.status);
