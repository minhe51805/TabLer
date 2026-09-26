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
    // vendor-monaco is fetched on demand (or via the idle prefetch in
    // main.tsx); preloading it from index.html would pull ~3.7 MB into the
    // critical path before first paint.
    modulePreload: {
      resolveDependencies(_url, deps) {
        return deps.filter((dep) => !dep.includes("vendor-monaco"));
      },
    },
    target:
      tauriPlatform === "windows" ? "chrome105" : tauriPlatform === "macos" ? "safari13" : "es2020",
    cssTarget: tauriPlatform === "windows" ? "chrome105" : undefined,
    // vendor-monaco must stay a pure lazy chunk: previously node_modules
    // shared by the entry graph (React internals, Rollup helpers) were merged
    // into it, which made main.* statically import vendor-monaco and evaluate
    // all 3.7 MB of Monaco at boot — defeating the idle prefetch. Route every
    // other node_module to `vendor` so nothing non-Monaco lands in the lazy
    // chunk.
    rollupOptions: {
      output: {
        // Keep shared Rollup/Vite helpers (_ / __vitePreload) OUT of manual
        // chunks — without this the helper lands in vendor-monaco and the
        // entry graph pulls all of Monaco in at boot just for that symbol.
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (
            id.includes("monaco-editor") ||
            id.includes("@monaco-editor") ||
            id.includes("monaco-vim")
          ) {
            return "vendor-monaco";
          }
          return "vendor";
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
      // 3. tell Vite to ignore watching `src-tauri`, the Next.js `website`
      // app, and build output — edits there must not reload the desktop dev UI
      ignored: ["**/src-tauri/**", "**/website/**", "**/dist/**", "**/dist-plugins/**"],
    },
  },
}));
