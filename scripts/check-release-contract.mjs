import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value.`);
  return value;
}

const packageJson = readJson("package.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const releaseConfig = readJson("src-tauri/tauri.release.conf.json");

const metadataResult = spawnSync(
  "cargo",
  [
    "metadata",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--no-deps",
    "--format-version",
    "1",
  ],
  { encoding: "utf8" },
);

if (metadataResult.status !== 0) {
  process.stderr.write(metadataResult.stderr || "cargo metadata failed.\n");
  process.exit(metadataResult.status ?? 1);
}

const metadata = JSON.parse(metadataResult.stdout);
const desktopPackage = metadata.packages.find((item) => item.name === "tabler");
const mcpPackage = metadata.packages.find((item) => item.name === "tabler-mcp");
if (!desktopPackage || !mcpPackage) fail("Both tabler and tabler-mcp Cargo packages are required.");

const versions = new Map([
  ["package.json", packageJson.version],
  ["tauri.conf.json", tauriConfig.version],
  ["desktop Cargo package", desktopPackage.version],
  ["MCP Cargo package", mcpPackage.version],
]);
const expectedVersion = packageJson.version;
const releaseLabel = packageJson.releaseLabel ?? expectedVersion;
if (typeof releaseLabel !== "string" || !releaseLabel.startsWith(expectedVersion)) {
  fail(`releaseLabel must start with the application version ${expectedVersion}.`);
}
for (const [source, version] of versions) {
  if (version !== expectedVersion) {
    fail(`Release version mismatch: ${source} is ${version}, expected ${expectedVersion}.`);
  }
}

const releaseTag = optionValue("--tag") ?? process.env.RELEASE_TAG;
if (releaseTag && releaseTag !== `v${releaseLabel}`) {
  fail(`Release tag ${releaseTag} does not match release label v${releaseLabel}.`);
}

if (typeof tauriConfig.identifier !== "string" || !/^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+){2,}$/.test(tauriConfig.identifier)) {
  fail("Tauri identifier must be a stable reverse-domain identifier with at least three segments.");
}
if (tauriConfig.identifier.toLowerCase().endsWith(".app")) {
  fail("Tauri identifier must not end with .app because it conflicts with the macOS bundle extension.");
}
if (releaseConfig?.bundle?.createUpdaterArtifacts !== true) {
  fail("Release config must enable bundle.createUpdaterArtifacts for signed updater bundles.");
}
const updaterConfig = tauriConfig?.plugins?.updater;
if (!updaterConfig?.pubkey || !updaterConfig?.endpoints?.length) {
  fail("Updater public key and endpoint must be configured before release.");
}
let decodedPublicKey;
try {
  decodedPublicKey = Buffer.from(updaterConfig.pubkey, "base64").toString("utf8").trim();
} catch {
  fail("Updater public key must be valid base64-encoded minisign public-key content.");
}
if (!/^untrusted comment: minisign public key: [0-9A-F]{16}\nRW[A-Za-z0-9+/=]+$/i.test(decodedPublicKey)) {
  fail("Updater public key is not valid minisign public-key content.");
}
for (const endpoint of updaterConfig.endpoints) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    fail(`Updater endpoint is invalid: ${endpoint}`);
  }
  if (url.protocol !== "https:" || !url.pathname.toLowerCase().endsWith("/releases/latest/download/latest.json")) {
    fail(`Updater endpoint must be an HTTPS latest.json release URL: ${endpoint}`);
  }
}

console.log(
  `Release contract is consistent for v${releaseLabel} (bundle ${expectedVersion})${releaseTag ? ` (${releaseTag})` : ""}.`,
);
