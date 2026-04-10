/**
 * Generate Tauri updater manifest (latest.json)
 * Usage: node scripts/generate-updater-manifest.mjs <version>
 *
 * Example:
 *   node scripts/generate-updater-manifest.mjs 0.1.0
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const version = process.argv[2] || "0.1.0";
const baseDir = resolve("./src-tauri/target/release");
const bundleDir = join(baseDir, "bundle");

function sha256(filePath) {
  const hash = createHash("sha256");
  const data = readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

function getFiles(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function getBundles(bundleDir) {
  const bundles = {};

  // NSIS installer (.exe)
  const nsisDir = join(bundleDir, "nsis");
  const nsisFiles = getFiles(nsisDir);
  for (const f of nsisFiles) {
    if (f.endsWith(".exe")) {
      const fullPath = join(nsisDir, f);
      const hash = sha256(fullPath);
      bundles["x86_64-pc-windows-msvc"] = {
        url: `https://github.com/minhe51805/TabLer/releases/download/v${version}/${f}`,
        sha256: hash,
        size: statSync(fullPath).size,
      };
    }
  }

  // MSI installer
  const msiDir = join(bundleDir, "msi");
  const msiFiles = getFiles(msiDir);
  for (const f of msiFiles) {
    if (f.endsWith(".msi")) {
      const fullPath = join(msiDir, f);
      const hash = sha256(fullPath);
      if (!bundles["x86_64-pc-windows-msvc"]) {
        bundles["x86_64-pc-windows-msvc"] = {
          url: `https://github.com/minhe51805/TabLer/releases/download/v${version}/${f}`,
          sha256: hash,
          size: statSync(fullPath).size,
        };
      }
    }
  }

  return bundles;
}

if (!statSync(bundleDir).isDirectory()) {
  console.log(`No bundle dir found at ${bundleDir}. Run 'npm run tauri build' first.`);
  process.exit(1);
}

const bundles = getBundles(bundleDir);

if (Object.keys(bundles).length === 0) {
  console.log("No bundles found. Make sure to build with 'npm run tauri build' first.");
  process.exit(1);
}

const manifest = {
  version: `${version}`,
  date: new Date().toISOString().split("T")[0],
  platforms: bundles,
};

const outFile = join(baseDir, "latest.json");
writeFileSync(outFile, JSON.stringify(manifest, null, 2));
console.log(`Manifest written to ${outFile}`);
console.log(JSON.stringify(manifest, null, 2));