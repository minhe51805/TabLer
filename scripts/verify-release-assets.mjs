import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(`Release asset verification failed: ${message}`);
}

export function verifyReleaseAssets(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      return { name: entry.name, size: fs.statSync(filePath).size };
    });
  if (entries.length === 0) fail("the downloaded draft has no files");
  const invalid = entries.find((entry) => entry.size <= 0 || /\.(?:part|partial|tmp)$/i.test(entry.name));
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
  return { count: entries.length, totalBytes: entries.reduce((total, entry) => total + entry.size, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) fail("usage: node scripts/verify-release-assets.mjs <directory>");
  const report = verifyReleaseAssets(path.resolve(directory));
  console.log(`Verified ${report.count} downloaded release assets (${report.totalBytes} bytes).`);
}
