import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { verifyReleaseAssets } from "../../scripts/verify-release-assets.mjs";

const roots = [];

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tabler-release-assets-"));
  roots.push(root);
  for (const name of files) fs.writeFileSync(path.join(root, name), "verified");
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe("downloaded release asset verifier", () => {
  it("accepts a complete three-platform draft", () => {
    const root = fixture([
      "TableR.msi", "TableR.dmg", "TableR.AppImage", "TableR.deb",
    ]);
    expect(verifyReleaseAssets(root)).toMatchObject({ count: 4 });
  });

  it("rejects a draft missing a platform", () => {
    const root = fixture([
      "TableR.msi", "TableR.dmg", "TableR.AppImage",
    ]);
    expect(() => verifyReleaseAssets(root)).toThrow("Linux package artifact is missing");
  });
});
