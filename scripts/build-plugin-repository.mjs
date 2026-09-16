// Assemble a self-contained, website-hostable *plugin repository* under
// `website/public/plugins/`. This is the "place that stores the loose plugins
// so the app can download them" — it turns the marketing website into the
// public home for every TableR driver plugin.
//
// It produces four things, all served straight from the website origin:
//
//   website/public/plugins/registry.json          <- the index the desktop app
//                                                     fetches (get_plugin_registry
//                                                     / install_registry_plugin).
//                                                     Asset URLs are ABSOLUTE https,
//                                                     because the Rust host rejects
//                                                     any non-https asset URL.
//   website/public/plugins/store.json              <- catalog metadata the /plugins
//                                                     web store page renders. Bundle
//                                                     links are SITE-RELATIVE so the
//                                                     browser "Download" button works
//                                                     on any origin (localhost too).
//   website/public/plugins/bundles/<id>-<ver>.zip  <- full bundle for manual
//                                                     "Install from disk" + the web
//                                                     download button.
//   website/public/plugins/assets/<id>/<ver>/...   <- per-file assets (native sidecar
//                                                     binaries) when they are present.
//
// The digest math is the exact mirror the Rust host runs at install time
// (`computeBundleDigest`), so a bundle here imports iff its committed
// `integrity.digest` matches — the same import gate the app enforces.
//
// Native `driver-sidecar-v1` plugins need a per-OS compiled binary in
// `bin/<os>-<arch>/` inside their source folder. Those binaries are produced by
// the release build (`npm run build:release:full`) and are NOT committed, so
// this generator marks such plugins `binaryPending` and emits no broken asset
// URLs — the app never 404s trying to download a binary that does not exist yet.
//
// Usage:
//   node scripts/build-plugin-repository.mjs
//   PLUGIN_REPO_BASE_URL=https://tabler.app node scripts/build-plugin-repository.mjs

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import {
  canonicalManifest,
  collectBundleFiles,
  computeBundleDigest,
} from "./build-plugin-registry.mjs";

const PLUGINS_ROOT = fileURLToPath(new URL("../plugins/", import.meta.url));
const OUT_DIR = fileURLToPath(new URL("../website/public/plugins/", import.meta.url));

// Public origin the desktop app downloads from. MUST be https for real installs
// (the Rust host runs `validate_https_url` on the registry URL and every asset
// URL). Override per deployment with PLUGIN_REPO_BASE_URL.
const REPO_BASE_URL = (process.env.PLUGIN_REPO_BASE_URL ?? "https://tabler.app").replace(
  /\/+$/,
  "",
);
const ASSET_BASE_URL = `${REPO_BASE_URL}/plugins/assets/`;
const REGISTRY_URL = `${REPO_BASE_URL}/plugins/registry.json`;

const HTTP_RUNTIME = "declarative-http-v1";
const SIDECAR_RUNTIME = "driver-sidecar-v1";

// Engine driver ids that already have a dedicated /docs/<slug> page. Kept in
// sync with `docsSlugs` in website/src/lib/docs.ts. Used only to decide whether
// a store card links to docs; a missing entry simply omits the docs link.
const DOC_SLUGS = new Set([
  "postgresql",
  "mysql",
  "mariadb",
  "cockroachdb",
  "greenplum",
  "amazon-redshift",
  "sql-server",
  "vertica",
  "clickhouse",
  "snowflake",
  "bigquery",
  "sqlite",
  "duckdb",
  "cassandra",
  "redis",
  "mongodb",
  "libsql",
  "cloudflare-d1",
]);

async function readManifest(bundleDir) {
  const raw = await readFile(join(bundleDir, "plugin.json"), "utf8");
  return JSON.parse(raw);
}

// Classify a plugin by the runtime of the drivers it contributes.
//  - "http"   : every driver is declarative-http-v1 (manifest-only, installs now)
//  - "native" : any driver is driver-sidecar-v1 (needs a per-OS binary)
//  - "format" : contributes no drivers (e.g. export formats)
function classify(manifest) {
  const drivers = manifest?.contributes?.drivers ?? [];
  if (drivers.length === 0) return "format";
  if (drivers.some((d) => d.runtime === SIDECAR_RUNTIME)) return "native";
  if (drivers.every((d) => d.runtime === HTTP_RUNTIME)) return "http";
  return "native"; // unknown/mixed runtimes: treat as needing extra files
}

// Registry asset descriptors for a bundle's non-manifest files. Mirrors
// `buildAssets` in build-plugin-registry.mjs but with the website asset base.
function buildAssets(manifest, files) {
  return files.map((file) => ({
    path: file.path,
    url: `${ASSET_BASE_URL}${manifest.id}/${manifest.version}/${file.path}`,
    sha256: createHash("sha256").update(file.contents).digest("hex"),
    size: file.contents.length,
  }));
}

// Deterministic .zip of a bundle: the re-serialized plugin.json plus every
// collected file, at a fixed timestamp so repeated runs are byte-stable.
async function zipBundle(manifest, files) {
  const zip = new JSZip();
  const fixedDate = new Date("2020-01-01T00:00:00Z");
  zip.file("plugin.json", `${JSON.stringify(manifest, null, 2)}\n`, { date: fixedDate });
  for (const file of files) {
    zip.file(file.path, file.contents, { date: fixedDate });
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

async function main() {
  const dirents = await readdir(PLUGINS_ROOT, { withFileTypes: true });
  const bundleDirs = dirents
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  // Reset output so a removed plugin cannot leave a stale artifact behind.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(join(OUT_DIR, "bundles"), { recursive: true });
  await mkdir(join(OUT_DIR, "assets"), { recursive: true });

  const packages = [];
  const storePlugins = [];
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

    const files = await collectBundleFiles(bundleDir);

    // (Re)stamp the integrity digest over the full bundle so the plugin.json we
    // ship is exactly what the host expects to import.
    manifest.integrity = {
      algorithm: "sha256",
      digest: computeBundleDigest(manifest, files),
    };

    const canonical = canonicalManifest(manifest);
    const category = classify(manifest);
    const drivers = canonical.contributes.drivers ?? [];
    const primaryDriver = drivers[0] ?? null;
    const binaryPending = category === "native" && files.length === 0;

    // Write per-file assets (native binaries) only when they actually exist.
    for (const file of files) {
      const assetDir = join(OUT_DIR, "assets", manifest.id, manifest.version);
      await mkdir(join(assetDir, ...file.path.split("/").slice(0, -1)), {
        recursive: true,
      });
      await writeFile(join(assetDir, ...file.path.split("/")), file.contents);
    }

    // Build + write the downloadable .zip bundle.
    const zipBuffer = await zipBundle(manifest, files);
    const zipName = `${manifest.id}-${manifest.version}.zip`;
    await writeFile(join(OUT_DIR, "bundles", zipName), zipBuffer);
    const zipSha256 = createHash("sha256").update(zipBuffer).digest("hex");

    // Registry package (app-facing). Assets are absolute https URLs.
    packages.push({
      manifest,
      assets: buildAssets(manifest, files),
      publishedAt: manifest.publishedAt ?? null,
      releaseNotes: `Registry package for ${manifest.name} ${manifest.version}.`,
    });

    // Store entry (web-facing). Bundle link is site-relative.
    const docsSlug =
      primaryDriver && DOC_SLUGS.has(primaryDriver.id) ? primaryDriver.id : null;
    storePlugins.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? "",
      author: manifest.author ?? "TableR Team",
      category,
      runtime: primaryDriver?.runtime ?? null,
      engine: primaryDriver
        ? {
            id: primaryDriver.id,
            label: primaryDriver.label,
            protocol: primaryDriver.protocol,
            status: primaryDriver.status,
          }
        : null,
      engines: drivers.map((d) => ({
        id: d.id,
        label: d.label,
        protocol: d.protocol,
        status: d.status,
      })),
      formats: (canonical.contributes.formats ?? []).map((f) => f.id),
      permissions: manifest.permissions ?? [],
      minAppVersion: manifest.compatibility?.minAppVersion ?? null,
      // "registry" installs straight from the app; "disk-binary" needs the
      // release binary before it can connect.
      installMode: binaryPending ? "disk-binary" : "registry",
      binaryPending,
      bundle: {
        path: `/plugins/bundles/${zipName}`,
        size: zipBuffer.length,
        sha256: zipSha256,
      },
      docsSlug,
      digest: manifest.integrity.digest,
    });
  }

  const generatedAt = new Date().toISOString();

  // App-facing registry index — identical shape to plugin-registry.json.
  const registry = {
    schemaVersion: 1,
    generatedAt,
    packages,
  };
  await writeFile(
    join(OUT_DIR, "registry.json"),
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf8",
  );

  // Web-facing catalog for the /plugins store page.
  const counts = {
    total: storePlugins.length,
    http: storePlugins.filter((p) => p.category === "http").length,
    native: storePlugins.filter((p) => p.category === "native").length,
    format: storePlugins.filter((p) => p.category === "format").length,
    installable: storePlugins.filter((p) => !p.binaryPending).length,
  };
  const store = {
    schemaVersion: 1,
    generatedAt,
    repoBaseUrl: REPO_BASE_URL,
    registryUrl: REGISTRY_URL,
    counts,
    plugins: storePlugins,
  };
  await writeFile(
    join(OUT_DIR, "store.json"),
    `${JSON.stringify(store, null, 2)}\n`,
    "utf8",
  );

  // Console report.
  console.log(`Plugin repository -> website/public/plugins/  (base ${REPO_BASE_URL})\n`);
  for (const p of storePlugins) {
    const tag = p.binaryPending ? "binary-pending" : "ready";
    console.log(
      `  [${p.category.padEnd(6)}] ${p.id.padEnd(22)} v${p.version}  (${tag})`,
    );
  }
  if (skipped.length) {
    console.log("\n  Skipped:");
    for (const s of skipped) console.log(`    - ${s.name}: ${s.reason}`);
  }
  console.log(
    `\n  ${counts.total} package(s): ${counts.http} HTTP, ${counts.native} native, ${counts.format} format. ` +
      `${counts.installable} installable now; ${counts.total - counts.installable} awaiting release binaries.`,
  );
  console.log(`  Registry URL: ${REGISTRY_URL}`);
}

await main();
