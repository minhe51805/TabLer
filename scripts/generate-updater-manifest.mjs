/**
 * Generate Tauri updater manifest (latest.json)
 * Usage: node scripts/generate-updater-manifest.mjs <version> <outDir>
 *
 * Prerequisites:
 *   npm install @tauri-apps/cli@2
 *
 * Environment variables:
 *   TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH
 *   TAURI_SIGNING_PRIVATE_KEY_PASSWORD (optional)
 */

import { createHash } from "node:fs";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash as createHashWeb } from "node:crypto";

const version = process.argv[2] || "0.1.0";
const outDir = resolve(process.argv[3] || "./src-tauri/target/release/bundle");

const platformMap = {
  "x86_64-pc-windows-msvc": {
    ext: ".exe",
    name: "Windows x64",
  },
  "x86_64-apple-darwin": {
    ext: ".app.tar.gz",
    name: "macOS x64",
  },
  "aarch64-apple-darwin": {
    ext: ".app.tar.gz",
    name: "macOS ARM64",
  },
  "x86_64-unknown-linux-gnu": {
    ext: ".AppImage.tar.gz",
    name: "Linux x64",
  },
};

function sha256(filePath) {
  const hash = createHashWeb("sha256");
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

function findBundle(dir, pattern) {
  const files = getFiles(dir);
  for (const file of files) {
    if (file.includes(pattern)) {
      const fullPath = join(dir, file);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        const found = findBundle(fullPath, pattern);
        if (found) return found;
      } else if (file.endsWith(".exe") || file.endsWith(".msi") || file.endsWith(".app.tar.gz") || file.endsWith(".AppImage.tar.gz")) {
        return fullPath;
      }
    }
  }
  return null;
}

function getBundles(buildDir) {
  const bundles = {};
  const subdirs = getFiles(buildDir);

  for (const subdir of subdirs) {
    const subPath = join(buildDir, subdir);
    try {
      if (!statSync(subPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // NSIS installer
    const nsisDir = join(subPath, "nsis");
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
    const msiDir = join(subPath, "msi");
    const msiFiles = getFiles(msiDir);
    for (const f of msiFiles) {
      if (f.endsWith(".msi")) {
        const fullPath = join(msiDir, f);
        const hash = sha256(fullPath);
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

const buildDir = join(outDir, "bundle");

if (!statSync(buildDir).isDirectory()) {
  console.log(`No bundle dir found at ${buildDir}. Run 'npm run tauri build' first.`);
  process.exit(1);
}

const bundles = getBundles(buildDir);

if (Object.keys(bundles).length === 0) {
  console.log("No bundles found. Make sure to build with 'npm run tauri build' first.");
  process.exit(1);
}

const manifest = {
  version: `${version}`,
  date: new Date().toISOString().split("T")[0],
  platforms: bundles,
};

const outFile = join(outDir, "latest.json");
writeFileSync(outFile, JSON.stringify(manifest, null, 2));
console.log(`Manifest written to ${outFile}`);
console.log(JSON.stringify(manifest, null, 2));
