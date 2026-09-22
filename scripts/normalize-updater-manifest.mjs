import { readFileSync, writeFileSync } from "node:fs";

// tauri-action uploads latest.json while the release is still a draft, so
// every platform URL is an api.github.com asset link. The updater manifest
// contract (and validate-updater-manifest.mjs) expects canonical
// /releases/download/<tag>/<asset> URLs, so rewrite each entry before the
// draft is validated and published.
//
// Asset names are resolved through the GitHub API from the numeric asset id —
// the minisign signature's `file:` field names the pre-upload filename, which
// does not always match the uploaded asset name (e.g. TableR.app.tar.gz is
// uploaded as TableR_0.1.6_aarch64.app.tar.gz).

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value.`);
  return value;
}

const file = optionValue("--file");
const tag = optionValue("--tag");
const repo = optionValue("--repo");
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) fail("GH_TOKEN or GITHUB_TOKEN is required to resolve asset names.");

const manifest = JSON.parse(readFileSync(file, "utf8"));
if (!manifest.platforms || typeof manifest.platforms !== "object") {
  fail("Updater manifest does not contain a platforms map.");
}

const assetNameCache = new Map();
async function assetNameFromId(assetId) {
  if (!assetNameCache.has(assetId)) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/releases/assets/${assetId}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      fail(`Cannot resolve asset ${assetId}: HTTP ${response.status}.`);
    }
    const asset = await response.json();
    assetNameCache.set(assetId, asset.name);
  }
  return assetNameCache.get(assetId);
}

let rewritten = 0;
for (const [platform, value] of Object.entries(manifest.platforms)) {
  if (!value || typeof value.url !== "string") {
    fail(`Updater entry ${platform} is missing a url.`);
  }
  const url = new URL(value.url);
  if (url.pathname.includes(`/releases/download/${tag}/`)) continue;

  const assetIdMatch = url.pathname.match(/\/releases\/assets\/(\d+)$/);
  if (url.hostname !== "api.github.com" || !assetIdMatch) {
    fail(`Updater entry ${platform} has an unexpected URL shape: ${value.url}`);
  }
  const assetName = await assetNameFromId(assetIdMatch[1]);
  value.url = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(assetName)}`;
  rewritten += 1;
}

writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Normalized ${rewritten} updater URL(s) to releases/download/${tag}.`);
