import path from "node:path";

// The repo root runs ESLint v10, but the `website/` package pins ESLint v9 and
// its config (Next.js / eslint-config-next) depends on eslint-plugin-react,
// whose rules call the ESLint v9 `context.getFilename()` API that was removed in
// v10. Linting `website/**` TS files with the repo-root ESLint therefore crashes
// ("contextOrFilename.getFilename is not a function"). To keep the pre-commit
// hook working for every package, route `website/**` TS files through the
// website's own ESLint (v9) and lint everything else with the repo-root ESLint.

const websiteDir = path.join(process.cwd(), "website");

/** True when `file` lives inside the `website/` package. */
function isWebsiteFile(file) {
  const relative = path.relative(websiteDir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Quote paths so directories containing spaces are handled safely. */
function quote(files) {
  return files.map((file) => `"${file}"`).join(" ");
}

// Windows CreateProcess caps a command line near 32K chars — a large staged
// set (e.g. a repo-wide audit commit) overflows it and the hook fails with
// "The command line is too long". Chunk the file list so each spawned
// command stays well under the limit.
const MAX_FILES_PER_COMMAND = 40;

/** Split `files` into batches and map each batch to a command string. */
function batched(files, command) {
  const commands = [];
  for (let index = 0; index < files.length; index += MAX_FILES_PER_COMMAND) {
    commands.push(command(files.slice(index, index + MAX_FILES_PER_COMMAND)));
  }
  return commands;
}

export default {
  "*.{ts,tsx}": (files) => {
    const websiteFiles = files.filter(isWebsiteFile);
    const rootFiles = files.filter((file) => !isWebsiteFile(file));
    const commands = [];

    commands.push(
      ...batched(rootFiles, (batch) => `eslint --fix --max-warnings=0 ${quote(batch)}`),
      ...batched(
        websiteFiles,
        (batch) => `npm --prefix website run lint -- --fix --max-warnings=0 ${quote(batch)}`,
      ),
      ...batched(files, (batch) => `prettier --write ${quote(batch)}`),
    );

    return commands;
  },
  "*.{js,jsx,mjs,cjs,json,jsonc,css,scss,md,mdx,yml,yaml,html}": ["prettier --write"],
  "*.rs": ["rustfmt --edition 2021"],
};
