import { spawnSync } from "node:child_process";

const result = spawnSync(
  "cargo",
  [
    "metadata",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--no-deps",
    "--format-version",
    "1",
  ],
  { encoding: "utf8" },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr || "cargo metadata failed.\n");
  process.exit(result.status ?? 1);
}

const metadata = JSON.parse(result.stdout);
const desktopPackage = metadata.packages.find((item) => item.name === "tabler");
const mcpPackage = metadata.packages.find((item) => item.name === "tabler-mcp");

if (!desktopPackage) {
  throw new Error("The TableR desktop Cargo package was not found.");
}

const desktopBins = desktopPackage.targets.filter((target) => target.kind.includes("bin"));
if (desktopBins.length !== 1 || desktopBins[0].name !== "tabler") {
  throw new Error(
    `The Tauri package must expose exactly one 'tabler' binary; found: ${desktopBins
      .map((target) => target.name)
      .join(", ") || "none"}.`,
  );
}

if (!mcpPackage || !mcpPackage.targets.some((target) => target.name === "tabler-mcp")) {
  throw new Error("The tabler-mcp binary must remain in its separate workspace package.");
}

console.log("Tauri desktop target is isolated from the optional tabler-mcp binary.");
