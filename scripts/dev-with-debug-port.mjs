// Launches the desktop app with WebView2 remote debugging enabled so
// scripts/cdp-inspect-terminal.mjs can attach to the live UI:
//   npm run dev:debug
import { spawn } from "node:child_process";

const env = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
    process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
    "--remote-debugging-port=9333",
  ]
    .filter(Boolean)
    .join(" "),
};

const child = spawn("npm", ["run", "tauri", "--", "dev"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env,
});

child.on("exit", (code) => process.exit(code ?? 0));
