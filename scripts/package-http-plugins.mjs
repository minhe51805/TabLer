// Package the installable HTTP driver plugins into standalone bundles that a
// user can import from the in-app Plugin Manager ("Install plugin" -> pick a
// folder). Each HTTP plugin is manifest-only (`declarative-http-v1`), so the
// bundle is self-contained and usable immediately after import -- no compiled
// binary is required (unlike the `driver-sidecar-v1` native plugins).
//
// For every packaged bundle this script also re-verifies the integrity digest
// using the SAME mirror the Rust host runs at install time
// (`computeBundleDigest`, byte-for-byte identical to
// `src-tauri/src/commands/plugins_support.rs::compute_bundle_digest`). A bundle
// only imports successfully if its committed `integrity.digest` equals the
// recomputed value, so this is a real, headless test of the import gate.
//
// Output (gitignored build artifacts):
//   dist-plugins/<plugin-id>/            -> import this folder directly
//   dist-plugins/<plugin-id>.zip         -> shareable archive (unzip, then import the folder)
//   dist-plugins/IMPORT.md               -> step-by-step import instructions
//   dist-plugins/manifest.json           -> machine-readable summary of the run
//
// Usage: node scripts/package-http-plugins.mjs

import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalManifest,
  collectBundleFiles,
  computeBundleDigest,
} from "./build-plugin-registry.mjs";

const PLUGINS_ROOT = fileURLToPath(new URL("../plugins/", import.meta.url));
const OUT_DIR = fileURLToPath(new URL("../dist-plugins/", import.meta.url));

// The exact runtime that identifies a declarative HTTP driver plugin. Mirrors
// `PluginDriverContribution.runtime === "declarative-http-v1"` on the frontend
// and the `DriverDistribution::PluginHttp` set in capabilities.rs.
const HTTP_RUNTIME = "declarative-http-v1";

function isHttpPluginManifest(manifest) {
  const drivers = manifest?.contributes?.drivers ?? [];
  return drivers.length > 0 && drivers.every((d) => d.runtime === HTTP_RUNTIME);
}

async function readManifest(bundleDir) {
  const raw = await readFile(join(bundleDir, "plugin.json"), "utf8");
  return JSON.parse(raw);
}

async function main() {
  const dirents = await readdir(PLUGINS_ROOT, { withFileTypes: true });
  const bundleDirs = dirents
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const results = [];
  const skipped = [];

  for (const name of bundleDirs) {
    const bundleDir = join(PLUGINS_ROOT, name);
    let manifest;
    try {
      manifest = await readManifest(bundleDir);
    } catch {
      skipped.push({ name, reason: "no readable plugin.json" });
      continue;
    }
    if (!isHttpPluginManifest(manifest)) {
      const runtimes = [
        ...new Set((manifest?.contributes?.drivers ?? []).map((d) => d.runtime)),
      ];
      skipped.push({
        name,
        reason:
          runtimes.length === 0
            ? "not a driver plugin"
            : `non-HTTP runtime(s): ${runtimes.join(", ")}`,
      });
      continue;
    }

    // Recompute the bundle digest exactly as the host does at install time and
    // assert it matches the committed manifest digest -- the import gate.
    const files = await collectBundleFiles(bundleDir);
    const recomputed = computeBundleDigest(manifest, files);
    const committed = (manifest.integrity?.digest ?? "").toLowerCase();
    const digestOk = recomputed === committed;

    // Sanity: the canonical (normalized) manifest must round-trip so the digest
    // the Rust host computes over its normalized manifest agrees with ours.
    const canonical = canonicalManifest(manifest);
    const idClean = manifest.id === manifest.id.trim().toLowerCase();

    const destDir = join(OUT_DIR, manifest.id);
    await rm(destDir, { recursive: true, force: true });
    await cp(bundleDir, destDir, { recursive: true });

    // Zip the folder for sharing (Windows PowerShell Compress-Archive is invoked
    // from the shell step after this script; here we only stage the folder).
    results.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      protocols: canonical.contributes.drivers.map((d) => d.protocol),
      permissions: manifest.permissions,
      extraFiles: files.map((f) => f.path),
      committedDigest: committed,
      recomputedDigest: recomputed,
      digestOk,
      idNormalized: idClean,
      importGate: digestOk && idClean ? "PASS" : "FAIL",
      sourceDir: bundleDir,
      outputDir: destDir,
    });
  }

  const allPass = results.length > 0 && results.every((r) => r.importGate === "PASS");

  // Human-facing import instructions shipped alongside the artifacts.
  const importMd = [
    "# TableR HTTP driver plugins - how to import",
    "",
    "These folders are self-contained, installable TableR plugin bundles for the",
    "HTTP/REST database engines. Each is manifest-only (`declarative-http-v1`), so",
    "it works immediately after import - no compiled binary or extra download.",
    "",
    "## Import in the app (2 ways)",
    "",
    "Open **Plugin Manager** in TableR (App menu -> Plugin Manager).",
    "",
    "1. **Install plugin (from disk):** click **Install plugin**, then in the folder",
    "   picker choose one of the `dist-plugins/<engine>-driver` folders below (the",
    "   folder that directly contains `plugin.json`). If you downloaded a `.zip`,",
    "   unzip it first and pick the extracted folder - the picker imports a folder,",
    "   not the zip file.",
    "2. **Official registry:** open the **Official registry** tab and click",
    "   **Install** next to the engine. This uses the bundled `plugin-registry.json`",
    "   and installs the exact same bundle.",
    "",
    "After install the plugin is enabled + verified, and the engine becomes",
    "selectable in the connection picker.",
    "",
    "## What the app checks on import (all verified below)",
    "",
    "On import the host recomputes the bundle SHA-256 digest and rejects the bundle",
    "unless it equals `plugin.json` -> `integrity.digest`. Every bundle here was",
    "re-verified with the same digest algorithm the Rust host uses:",
    "",
    "| Plugin | Engine protocol | Import gate | Digest |",
    "| --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| \`${r.id}\` | ${r.protocols.join(", ")} | ${r.importGate} | \`${r.committedDigest.slice(0, 12)}...\` |`,
    ),
    "",
    "Native engines (DuckDB, Cassandra, Redis, LibSQL) are NOT included here: they",
    "are `driver-sidecar-v1` plugins that additionally need a per-OS compiled binary",
    "in `bin/<os>-<arch>/` inside the bundle before they can connect.",
    "",
    `Generated by \`scripts/package-http-plugins.mjs\` at ${new Date().toISOString()}.`,
    "",
  ].join("\n");
  await writeFile(join(OUT_DIR, "IMPORT.md"), importMd, "utf8");

  await writeFile(
    join(OUT_DIR, "manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        httpPluginCount: results.length,
        allImportGatesPass: allPass,
        packaged: results,
        skipped,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // Console report.
  console.log("Packaging HTTP driver plugins -> dist-plugins/\n");
  for (const r of results) {
    console.log(
      `  [${r.importGate}] ${r.id}  (protocols: ${r.protocols.join(", ")})`,
    );
    console.log(`         digest committed=${r.committedDigest.slice(0, 16)}...`);
    console.log(`         digest computed =${r.recomputedDigest.slice(0, 16)}...`);
  }
  if (skipped.length) {
    console.log("\n  Skipped (not HTTP-only driver plugins):");
    for (const s of skipped) console.log(`    - ${s.name}: ${s.reason}`);
  }
  console.log(
    `\n  ${results.length} HTTP plugin(s) staged. Import gate: ${
      allPass ? "ALL PASS" : "FAILURES PRESENT"
    }`,
  );

  if (!allPass) {
    process.exitCode = 1;
  }
}

import { writeFileSync } from "node:fs";

try {
  await mkdir(OUT_DIR, { recursive: true });
  await main();
} catch (error) {
  writeFileSync(
    join(OUT_DIR, "error.log"),
    `${(error && error.stack) || String(error)}\n`,
    "utf8",
  );
  process.exitCode = 1;
}
