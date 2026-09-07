import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = packageJson.version;
const releaseTag = `v${packageJson.releaseLabel ?? version}`;

function runScript(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("release scripts", () => {
  it("accepts the current release tag and rejects a mismatched tag", () => {
    const accepted = runScript("scripts/check-release-contract.mjs", ["--tag", releaseTag]);
    expect(accepted.status, accepted.stderr).toBe(0);

    const rejected = runScript("scripts/check-release-contract.mjs", ["--tag", "v9.9.9"]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("does not match release label");
  });

  it("matches updater metadata signatures to the uploaded assets", () => {
    const root = mkdtempSync(join(tmpdir(), "tabler-updater-test-"));
    try {
      const signatures = {
        "TableR.AppImage.sig": "sig-linux",
        "TableR-setup.exe.sig": "sig-windows",
        "TableR.app.tar.gz.sig": "sig-macos",
      };
      for (const [name, value] of Object.entries(signatures)) {
        writeFileSync(join(root, name), value);
      }

      const manifestPath = join(root, "latest.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          version,
          platforms: {
            "linux-x86_64": {
              url: `https://github.com/minhe51805/TableR/releases/download/${releaseTag}/TableR.AppImage`,
              signature: "sig-linux",
            },
            "windows-x86_64": {
              url: `https://github.com/minhe51805/TableR/releases/download/${releaseTag}/TableR-setup.exe`,
              signature: "sig-windows",
            },
            "darwin-aarch64": {
              url: `https://github.com/minhe51805/TableR/releases/download/${releaseTag}/TableR.app.tar.gz`,
              signature: "sig-macos",
            },
          },
        }),
      );

      const accepted = runScript("scripts/validate-updater-manifest.mjs", [
        "--file",
        manifestPath,
        "--tag",
        releaseTag,
        "--assets",
        root,
      ]);
      expect(accepted.status, accepted.stderr).toBe(0);

      writeFileSync(join(root, "TableR.AppImage.sig"), "tampered");
      const rejected = runScript("scripts/validate-updater-manifest.mjs", [
        "--file",
        manifestPath,
        "--tag",
        releaseTag,
        "--assets",
        root,
      ]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("does not match TableR.AppImage.sig");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
