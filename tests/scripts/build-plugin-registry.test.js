import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildAssets,
  canonicalManifest,
  collectBundleFiles,
  computeBundleDigest,
} from "../../scripts/build-plugin-registry.mjs";

const roots = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function sidecarManifest() {
  return {
    apiVersion: 1,
    id: "duckdb-driver",
    name: "DuckDB sidecar driver",
    version: "1.2.0",
    publishedAt: "2026-08-01T00:00:00.000Z",
    kind: "adapter",
    capabilities: ["database"],
    permissions: ["connection.metadata", "query.read", "query.execute"],
    compatibility: { platforms: [], architectures: [] },
    contributes: {
      drivers: [
        {
          id: "duckdb",
          label: "DuckDB",
          protocol: "duckdb",
          runtime: "driver-sidecar-v1",
          status: "experimental",
        },
      ],
    },
  };
}

// Independent, spec-faithful reconstruction of the Rust host's
// `compute_bundle_digest` byte framing (src-tauri/.../plugins_support.rs).
// Kept deliberately separate from the script's streaming implementation so a
// framing/ordering regression on either side is caught, not re-derived.
function referenceDigest(manifest, files) {
  const u64le = (value) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
  };
  const parts = [];
  const semantic = Buffer.from(JSON.stringify(canonicalManifest(manifest)), "utf8");
  parts.push(Buffer.from("plugin.json\0", "utf8"), u64le(semantic.length), semantic);
  const ordered = [...files]
    .filter((file) => file.path !== "plugin.json")
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  for (const file of ordered) {
    parts.push(
      Buffer.from(file.path, "utf8"),
      Buffer.from([0]),
      u64le(file.contents.length),
      file.contents,
    );
  }
  return createHash("sha256").update(Buffer.concat(parts)).digest("hex");
}

const platformBinaries = () => [
  { path: "bin/linux-x86_64/duckdb", contents: Buffer.from("elf-linux-x86_64\u0000\u0001") },
  { path: "bin/macos-aarch64/duckdb", contents: Buffer.from("macho-arm64") },
  { path: "bin/windows-x86_64/duckdb.exe", contents: Buffer.from("pe-windows-x86_64") },
];

describe("plugin registry bundle digest (sidecar-ready)", () => {
  it("matches the reference framing for a manifest-only bundle", () => {
    const manifest = sidecarManifest();
    expect(computeBundleDigest(manifest, [])).toBe(referenceDigest(manifest, []));
  });

  it("folds every per-platform sidecar binary into the digest", () => {
    const manifest = sidecarManifest();
    const files = platformBinaries();
    expect(computeBundleDigest(manifest, files)).toBe(referenceDigest(manifest, files));
  });

  it("is order-independent (host collects files in sorted order)", () => {
    const manifest = sidecarManifest();
    const files = platformBinaries();
    const shuffled = [files[2], files[0], files[1]];
    expect(computeBundleDigest(manifest, shuffled)).toBe(computeBundleDigest(manifest, files));
  });

  it("changes when a binary is added, renamed, or its bytes change", () => {
    const manifest = sidecarManifest();
    const files = platformBinaries();
    const base = computeBundleDigest(manifest, files);
    expect(computeBundleDigest(manifest, files.slice(0, 2))).not.toBe(base);
    const renamed = files.map((file, index) =>
      index === 0 ? { ...file, path: "bin/linux-arm64/duckdb" } : file,
    );
    expect(computeBundleDigest(manifest, renamed)).not.toBe(base);
    const mutated = files.map((file, index) =>
      index === 0 ? { ...file, contents: Buffer.from("tampered") } : file,
    );
    expect(computeBundleDigest(manifest, mutated)).not.toBe(base);
  });

  it("emits one download asset per binary with sha256 + byte size", () => {
    const manifest = sidecarManifest();
    const files = platformBinaries();
    const assets = buildAssets(manifest, files, "https://plugins.tabler.app/assets/");
    expect(assets).toEqual(
      files.map((file) => ({
        path: file.path,
        url: `https://plugins.tabler.app/assets/duckdb-driver/1.2.0/${file.path}`,
        sha256: createHash("sha256").update(file.contents).digest("hex"),
        size: file.contents.length,
      })),
    );
  });

  it("collects files recursively as POSIX paths and skips plugin.json", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tabler-bundle-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "plugin.json"), "{}");
    fs.mkdirSync(path.join(root, "bin", "linux-x86_64"), { recursive: true });
    fs.writeFileSync(path.join(root, "bin", "linux-x86_64", "duckdb"), "elf");
    fs.mkdirSync(path.join(root, "bin", "windows-x86_64"), { recursive: true });
    fs.writeFileSync(path.join(root, "bin", "windows-x86_64", "duckdb.exe"), "pe");

    const files = await collectBundleFiles(root);
    expect(files.map((file) => file.path)).toEqual([
      "bin/linux-x86_64/duckdb",
      "bin/windows-x86_64/duckdb.exe",
    ]);
    // The digest built from the collected files equals the reference over the
    // same inputs — the collector and the hasher agree end to end.
    expect(computeBundleDigest(sidecarManifest(), files)).toBe(
      referenceDigest(sidecarManifest(), files),
    );
  });
});
