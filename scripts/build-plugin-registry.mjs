import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Base URL sidecar/binary assets are downloaded from at install time. Assets are
// hosted per release (not committed); override with PLUGIN_ASSET_BASE_URL.
const assetBaseUrl = (
  process.env.PLUGIN_ASSET_BASE_URL ?? "https://plugins.tabler.app/assets/"
).replace(/\/?$/, "/");

export function canonicalManifest(manifest) {
  return {
    apiVersion: manifest.apiVersion,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    kind: manifest.kind,
    description: manifest.description ?? null,
    author: manifest.author ?? null,
    entry: manifest.entry ?? null,
    capabilities: manifest.capabilities ?? [],
    permissions: manifest.permissions ?? [],
    compatibility: {
      minAppVersion: manifest.compatibility?.minAppVersion ?? null,
      maxAppVersion: manifest.compatibility?.maxAppVersion ?? null,
      platforms: manifest.compatibility?.platforms ?? [],
      architectures: manifest.compatibility?.architectures ?? [],
    },
    integrity: null,
    updateUrl: manifest.updateUrl ?? null,
    contributes: {
      formats: (manifest.contributes?.formats ?? []).map((format) => ({
        id: format.id,
        label: format.label,
        description: format.description ?? null,
        extension: format.extension,
        mimeType: format.mimeType,
        mode: format.mode,
        delimiter: format.delimiter ?? null,
        includeHeader: format.includeHeader ?? true,
      })),
      drivers: (manifest.contributes?.drivers ?? []).map((driver) => ({
        id: driver.id,
        label: driver.label,
        protocol: driver.protocol,
        runtime: driver.runtime,
        status: driver.status,
      })),
    },
  };
}

function updateU64LE(hash, value) {
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(value));
  hash.update(size);
}

function comparePosixPath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// SHA-256 digest of a plugin bundle, byte-for-byte identical to the Rust host's
// `compute_bundle_digest` (src-tauri/src/commands/plugins_support.rs). The host
// recomputes this at install time and rejects the bundle unless it matches
// `manifest.integrity.digest`, so the two implementations must agree exactly:
//   - the semantic manifest first: "plugin.json\0" + u64LE(len) + bytes
//   - then every OTHER file, sorted by its forward-slash bundle-relative path:
//     path + 0x00 + u64LE(len) + contents
// `files` is `[{ path, contents }]` (path = POSIX relative path, contents =
// Buffer). `plugin.json` is carried by `manifest` and is skipped here.
export function computeBundleDigest(manifest, files = []) {
  const hash = createHash("sha256");
  const semantic = Buffer.from(JSON.stringify(canonicalManifest(manifest)), "utf8");
  hash.update(Buffer.from("plugin.json\0", "utf8"));
  updateU64LE(hash, semantic.length);
  hash.update(semantic);

  const ordered = files
    .filter((file) => file.path !== "plugin.json")
    .sort((left, right) => comparePosixPath(left.path, right.path));
  for (const file of ordered) {
    hash.update(Buffer.from(file.path, "utf8"));
    hash.update(Buffer.from([0]));
    updateU64LE(hash, file.contents.length);
    hash.update(file.contents);
  }
  return hash.digest("hex");
}

// Collect every bundle file except `plugin.json`, recursively, as
// `{ path, contents }` with POSIX-normalized bundle-relative paths. For a
// `driver-sidecar-v1` bundle these are the per-platform binaries laid out as
// `bin/<os>-<arch>/<driver_id>[.exe]`; a format/HTTP bundle simply has none.
export async function collectBundleFiles(bundleDirPath) {
  const entries = await readdir(bundleDirPath, {
    withFileTypes: true,
    recursive: true,
  });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath ?? entry.path, entry.name);
    const posixPath = relative(bundleDirPath, absolute).split(/[\\/]/).join("/");
    if (posixPath === "plugin.json") continue;
    files.push({ path: posixPath, contents: await readFile(absolute) });
  }
  return files.sort((left, right) => comparePosixPath(left.path, right.path));
}

// Registry asset descriptors for the bundle's non-manifest files. At install
// time the host downloads each to `<bundle>/<path>`, checks its sha256, then
// re-verifies the whole bundle digest. Sidecar binaries are published per
// platform under `bin/<os>-<arch>/…`.
export function buildAssets(manifest, files, baseUrl = assetBaseUrl) {
  return files.map((file) => ({
    path: file.path,
    url: `${baseUrl}${manifest.id}/${manifest.version}/${file.path}`,
    sha256: createHash("sha256").update(file.contents).digest("hex"),
    size: file.contents.length,
  }));
}

// Scan the plugins root, (re)stamp each manifest's integrity digest over its
// full bundle, and return the registry index. When `write` is true the manifest
// files are rewritten in place (the CLI path); tests call it with the pure
// helpers above instead.
export async function buildRegistry(pluginsRootPath, { write = true } = {}) {
  const directories = (await readdir(pluginsRootPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));

  const packages = [];
  for (const directory of directories) {
    const bundleDir = join(pluginsRootPath, directory.name);
    const manifestPath = join(bundleDir, "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const files = await collectBundleFiles(bundleDir);
    manifest.integrity = {
      algorithm: "sha256",
      digest: computeBundleDigest(manifest, files),
    };
    if (write) {
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }
    packages.push({
      manifest,
      assets: buildAssets(manifest, files),
      publishedAt: manifest.publishedAt,
      releaseNotes: `Built-in registry package for ${manifest.name} ${manifest.version}.`,
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: packages
      .map((item) => item.publishedAt)
      .sort()
      .at(-1),
    packages,
  };
}

// CLI entry point (skipped when the module is imported by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pluginsRootPath = fileURLToPath(new URL("../plugins/", import.meta.url));
  const registry = await buildRegistry(pluginsRootPath);
  await writeFile(
    new URL("../plugin-registry.json", import.meta.url),
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `Generated plugin-registry.json with ${registry.packages.length} package(s).`,
  );
}
