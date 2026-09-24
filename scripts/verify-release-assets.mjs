import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(`Release asset verification failed: ${message}`);
}

export function verifyReleaseAssets(directory, options = {}) {
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      return { name: entry.name, size: fs.statSync(filePath).size };
    });
  if (entries.length === 0) fail("the downloaded draft has no files");
  const invalid = entries.find(
    (entry) => entry.size <= 0 || /\.(?:part|partial|tmp)$/i.test(entry.name),
  );
  if (invalid) fail(`asset '${invalid.name}' is empty or incomplete`);

  const names = entries.map((entry) => entry.name);
  const required = [
    ["Windows", (name) => /\.(?:msi|exe)$/i.test(name)],
    ["macOS", (name) => /\.dmg$/i.test(name)],
    ["Linux AppImage", (name) => /\.appimage$/i.test(name)],
    ["Linux package", (name) => /\.(?:deb|rpm)$/i.test(name)],
  ];
  for (const [label, matches] of required) {
    if (!names.some(matches)) fail(`${label} artifact is missing`);
  }

  // When updater signing was enabled for this release, the auto-update
  // manifest and per-bundle signatures must be present — a release without
  // them leaves installed clients unable to update (and the updater endpoint
  // 404s). The expectation defaults to "on" whenever tauri.conf.json actually
  // configures an updater endpoint, so a misconfigured pipeline fails loudly
  // instead of silently shipping a release with no latest.json.
  const updaterConfigured = (() => {
    try {
      const config = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
      return Boolean(config?.plugins?.updater?.endpoints?.length);
    } catch {
      return false;
    }
  })();
  const expectUpdater =
    options.expectUpdater ??
    (process.env.EXPECT_UPDATER_ARTIFACTS !== undefined
      ? process.env.EXPECT_UPDATER_ARTIFACTS === "true"
      : updaterConfigured);
  if (expectUpdater) {
    if (!names.includes("latest.json")) {
      fail("updater manifest 'latest.json' is missing (updater signing was enabled)");
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(directory, "latest.json"), "utf8"));
    } catch (error) {
      fail(
        `updater manifest 'latest.json' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !manifest.platforms ||
      typeof manifest.platforms !== "object" ||
      Object.keys(manifest.platforms).length === 0
    ) {
      fail("updater manifest 'latest.json' has no platform entries");
    }
    if (!names.some((name) => /\.sig$/i.test(name))) {
      fail("no updater signature (.sig) assets found (updater signing was enabled)");
    }
  }
  return {
    count: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) fail("usage: node scripts/verify-release-assets.mjs <directory>");
  const expectUpdater = process.argv.includes("--expect-updater") ? true : undefined;
  const report = verifyReleaseAssets(path.resolve(directory), { expectUpdater });
  console.log(`Verified ${report.count} downloaded release assets (${report.totalBytes} bytes).`);
}
