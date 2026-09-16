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

export default {
  "*.{ts,tsx}": (files) => {
    const websiteFiles = files.filter(isWebsiteFile);
    const rootFiles = files.filter((file) => !isWebsiteFile(file));
    const commands = [];

    if (rootFiles.length > 0) {
      commands.push(`eslint --fix --max-warnings=0 ${quote(rootFiles)}`);
    }
    if (websiteFiles.length > 0) {
      commands.push(
        `npm --prefix website run lint -- --fix --max-warnings=0 ${quote(websiteFiles)}`,
      );
    }
    if (files.length > 0) {
      commands.push(`prettier --write ${quote(files)}`);
    }

    return commands;
  },
  "*.{js,jsx,mjs,cjs,json,jsonc,css,scss,md,mdx,yml,yaml,html}": ["prettier --write"],
  "*.rs": ["rustfmt --edition 2021"],
};
