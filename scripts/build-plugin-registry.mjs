import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const pluginsRoot = new URL("../plugins/", import.meta.url);
const pluginsRootPath = fileURLToPath(pluginsRoot);

function canonicalManifest(manifest) {
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

function bundleDigest(manifest) {
  const semantic = Buffer.from(JSON.stringify(canonicalManifest(manifest)), "utf8");
  const hash = createHash("sha256");
  hash.update(Buffer.from("plugin.json\0", "utf8"));
  updateU64LE(hash, semantic.length);
  hash.update(semantic);
  return hash.digest("hex");
}

const directories = (await readdir(pluginsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name));

const packages = [];
for (const directory of directories) {
  const manifestPath = join(pluginsRootPath, directory.name, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.integrity = { algorithm: "sha256", digest: bundleDigest(manifest) };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  packages.push({
    manifest,
    assets: [],
    publishedAt: manifest.publishedAt,
    releaseNotes: `Built-in registry package for ${manifest.name} ${manifest.version}.`,
  });
}

const registry = {
  schemaVersion: 1,
  generatedAt: packages
    .map((item) => item.publishedAt)
    .sort()
    .at(-1),
  packages,
};
await writeFile(
  new URL("plugin-registry.json", root),
  `${JSON.stringify(registry, null, 2)}\n`,
  "utf8",
);

console.log(`Generated plugin-registry.json with ${packages.length} package(s).`);
