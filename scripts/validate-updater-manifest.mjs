import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function optionValue(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (required && (!value || value.startsWith("--"))) fail(`${name} requires a value.`);
  return value;
}

const file = optionValue("--file");
const tag = optionValue("--tag");
const assetsDir = optionValue("--assets");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const expectedTag = `v${packageJson.releaseLabel ?? packageJson.version}`;
if (tag !== expectedTag) {
  fail(`Release tag ${tag} does not match release label ${expectedTag}.`);
}
let manifest;
try {
  manifest = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  fail(`Cannot read updater manifest: ${error instanceof Error ? error.message : String(error)}`);
}

const expectedVersion = packageJson.version;
if (manifest.version !== expectedVersion && manifest.version !== tag) {
  fail(`Updater version ${manifest.version} does not match release tag ${tag}.`);
}
if (!manifest.platforms || typeof manifest.platforms !== "object") {
  fail("Updater manifest does not contain a platforms map.");
}

const entries = Object.entries(manifest.platforms);
for (const platform of ["linux", "windows", "darwin"]) {
  if (!entries.some(([key]) => key === platform || key.startsWith(`${platform}-`))) {
    fail(`Updater manifest is missing a ${platform} artifact.`);
  }
}

for (const [platform, value] of entries) {
  if (!value || typeof value !== "object") fail(`Updater entry ${platform} is invalid.`);
  if (typeof value.url !== "string" || typeof value.signature !== "string") {
    fail(`Updater entry ${platform} must contain url and signature strings.`);
  }
  let url;
  try {
    url = new URL(value.url);
  } catch {
    fail(`Updater entry ${platform} has an invalid URL.`);
  }
  if (url.protocol !== "https:") fail(`Updater entry ${platform} must use HTTPS.`);
  if (!decodeURIComponent(url.pathname).includes(`/releases/download/${tag}/`)) {
    fail(`Updater entry ${platform} does not point to release ${tag}.`);
  }
  if (!value.signature.trim()) fail(`Updater entry ${platform} has an empty signature.`);

  const assetName = basename(decodeURIComponent(url.pathname));
  const signaturePath = join(assetsDir, `${assetName}.sig`);
  if (!existsSync(signaturePath)) fail(`Missing signature asset ${assetName}.sig.`);
  const signatureAsset = readFileSync(signaturePath, "utf8").trim();
  if (signatureAsset !== value.signature.trim()) {
    fail(`Updater signature for ${platform} does not match ${assetName}.sig.`);
  }
}

console.log(`Updater manifest verified for ${entries.length} platform artifact(s) on ${tag}.`);
