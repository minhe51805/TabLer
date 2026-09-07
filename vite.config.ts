import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const tauriPlatform = process.env.TAURI_ENV_PLATFORM;
const isTauriDev = !!host;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  base: isTauriDev ? "/" : "./",
  build: {
    target:
      tauriPlatform === "windows"
        ? "chrome105"
        : tauriPlatform === "macos"
          ? "safari13"
          : "es2020",
    cssTarget: tauriPlatform === "windows" ? "chrome105" : undefined,
    // Disable manual chunks for production to ensure WebView2 compatibility
    // Single bundle eliminates chunk loading race conditions
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          // Only separate heavy Monaco editor to its own chunk
          if (id.includes("@monaco-editor") || id.includes("monaco-editor")) {
            return "vendor-monaco";
          }
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
