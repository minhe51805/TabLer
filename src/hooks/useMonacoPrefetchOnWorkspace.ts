import { useEffect, useRef } from "react";

/**
 * Warm the vendor-monaco chunk the moment a workspace becomes renderable,
 * not at boot. The launcher itself needs no SQL editor, so a session that
 * stays on the connection screen should never pay the ~3.9 MB fetch/eval.
 *
 * `monaco-bundle` is a lazy boundary: the dynamic import inside the shim
 * keeps Vite from treating vendor-monaco as an entry dependency, and the
 * `import()` here only fetches + evaluates it ahead of the first editor
 * mount. Failures are swallowed — the real import retries on demand.
 */
export function useMonacoPrefetchOnWorkspace(isWorkspaceActive: boolean): void {
  const prefetched = useRef(false);

  useEffect(() => {
    if (!isWorkspaceActive || prefetched.current) return;
    prefetched.current = true;
    void import("../utils/monaco-prefetch")
      .then((module) => module.prefetchMonacoBundle())
      .catch(() => {
        // Warm-up is best-effort; the editor's own import still runs on demand.
      });
  }, [isWorkspaceActive]);
}
