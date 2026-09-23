import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { emitAppToast } from "../../utils/app-toast";

/** Payload emitted by the Rust storage layer on the `storage-notice` event. */
interface StorageNotice {
  id: string;
  kind: "corrupt" | "warning" | "info" | string;
  title: string;
  message: string;
}

const isDesktopWindow = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Notices are deduped by id: the hook mounts in both the startup manager and
// the workspace titlebar, and the same notice can arrive via the event and
// the drain command.
const deliveredNoticeIds = new Set<string>();

function deliverNotice(notice: StorageNotice) {
  if (deliveredNoticeIds.has(notice.id)) return;
  deliveredNoticeIds.add(notice.id);
  emitAppToast({
    tone: notice.kind === "corrupt" ? "error" : notice.kind === "warning" ? "error" : "info",
    title: notice.title,
    description: notice.message,
    durationMs: 12_000,
  });
}

/**
 * Surfaces storage-layer notices (corrupt files quarantined, sync folder
 * unavailable, missing keyring credentials) as app toasts. Subscribes to the
 * `storage-notice` event first, then drains any notices emitted before the
 * listener attached so nothing is lost in the startup race.
 */
export function useStorageNotices() {
  useEffect(() => {
    if (!isDesktopWindow()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void listen<StorageNotice>("storage-notice", (event) => {
      deliverNotice(event.payload);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    void invoke<StorageNotice[]>("drain_storage_notices")
      .then((notices) => {
        if (!cancelled) notices.forEach(deliverNotice);
      })
      .catch(() => {
        // Older backend without the command — notices still arrive via events.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
