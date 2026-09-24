// Prefetch shim: main.tsx imports this module dynamically so Vite does not
// add vendor-monaco to index.html's modulepreload list (which would fetch
// ~3.7 MB before first paint). The nested dynamic import keeps Monaco a
// lazy boundary while warming the chunk during idle time.
export function prefetchMonacoBundle(): void {
  import("./monaco-bundle").catch(() => {
    // Prefetch failure is harmless — the real import retries on demand.
  });
}
