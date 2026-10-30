import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function prepareE2EBinary({ sourceBinary, outputBinary }) {
  await stat(sourceBinary);
  await mkdir(path.dirname(outputBinary), { recursive: true });
  await copyFile(sourceBinary, outputBinary);
  const copied = await stat(outputBinary);
  if (copied.size === 0) throw new Error("E2E binary copy is empty");
  return outputBinary;
}

async function main() {
  const executable = process.platform === "win32" ? "tabler.exe" : "tabler";
  const output = await prepareE2EBinary({
    sourceBinary: path.join(repoRoot, "src-tauri", "target", "debug", executable),
    outputBinary: path.join(
      repoRoot,
      ".artifacts",
      "e2e",
      `tabler-e2e${process.platform === "win32" ? ".exe" : ""}`,
    ),
  });
  console.log(`E2E binary isolated at ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
