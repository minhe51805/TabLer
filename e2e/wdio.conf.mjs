import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const binary = process.env.TABLER_E2E_BINARY || path.join(
  root,
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "tabler.exe" : "tabler",
);
const artifacts = path.join(root, ".artifacts", "e2e");
fs.mkdirSync(artifacts, { recursive: true });

export const config = {
  runner: "local",
  outputDir: path.join(artifacts, "wdio-logs"),
  specs: ["./specs/**/*.e2e.mjs"],
  maxInstances: 1,
  capabilities: [{
    browserName: "tauri",
    "tauri:options": { application: binary },
  }],
  services: [["@wdio/tauri-service", {
    appBinaryPath: binary,
    driverProvider: "official",
    autoInstallTauriDriver: true,
    autoDownloadEdgeDriver: true,
    captureBackendLogs: true,
    captureFrontendLogs: true,
    startTimeout: 60_000,
    commandTimeout: 30_000,
  }]],
  framework: "mocha",
  reporters: [["spec", { addFileContext: true }]],
  logLevel: "info",
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  mochaOpts: { ui: "bdd", timeout: 90_000 },
  afterTest: async function (test, _context, result) {
    const safeName = test.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    await browser.saveScreenshot(path.join(
      artifacts,
      `${safeName}-${result.passed ? "passed" : "failed"}.png`,
    ));
    if (result.passed) return;
    fs.writeFileSync(
      path.join(artifacts, `${safeName}.json`),
      JSON.stringify({
        title: test.title,
        error: result.error?.message ?? "unknown failure",
      }, null, 2),
    );
  },
};
