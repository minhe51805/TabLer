import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * Window-level file drop → CSV import wizard.
 *
 * `dragDropEnabled` is false in tauri.conf.json, so the OS drop surfaces as a
 * Tauri `onDragDropEvent` carrying real file paths (DOM `drop` events never
 * fire). The first `.csv`/`.tsv` path opens the ImportWizard pre-filled via
 * the `open-data-import-palette` event the wizard already listens for.
 *
 * The wizard lives inside lazily-mounted AppGlobalModals, so a drop that lands
 * while it is unmounted is stashed in `pendingCsvDropPath`; the wizard drains
 * it on mount via `consumePendingCsvDrop`.
 */
let pendingCsvDropPath: string | null = null;

/** Take (and clear) a CSV path dropped before the wizard was mounted. */
export function consumePendingCsvDrop(): string | null {
  const path = pendingCsvDropPath;
  pendingCsvDropPath = null;
  return path;
}

const CSV_DROP_EXTENSIONS: Record<string, true> = { csv: true, tsv: true };

function isCsvPath(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return CSV_DROP_EXTENSIONS[extension] === true;
}

export function useCsvFileDrop() {
  useEffect(() => {
    // Plain browsers/tests have no Tauri window bridge — getCurrentWindow()
    // dereferences __TAURI_INTERNALS__.metadata and would throw here.
    if (!("__TAURI_INTERNALS__" in window)) return;

    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const path = event.payload.paths.find(isCsvPath);
        if (!path) return;
        pendingCsvDropPath = path;
        window.dispatchEvent(
          new CustomEvent<{ path: string }>("open-data-import-palette", {
            detail: { path },
          }),
        );
      })
      .then((cleanup) => {
        if (disposed) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch(() => {
        // Browser-only previews/tests have no Tauri window bridge.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
