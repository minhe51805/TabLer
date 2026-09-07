import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

export type AppUpdatePhase = "idle" | "available" | "downloading" | "installing";

export interface AppUpdateInfo {
  version: string;
  notes: string;
}

interface UpdateStatusPayload {
  available: boolean;
  version: string | null;
  body: string | null;
}

const isDesktopWindow = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * In-app update lifecycle: check for a newer release shortly after mount,
 * expose the found version/notes, then download + install + relaunch on
 * demand. Backed by the Tauri updater plugin via the app's own commands
 * (check_for_update / download_and_install_update / restart_app).
 */
export function useAppUpdater() {
  const [update, setUpdate] = useState<AppUpdateInfo | null>(null);
  const [phase, setPhase] = useState<AppUpdatePhase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const desktop = isDesktopWindow();

  const checkForUpdate = useCallback(async () => {
    if (!isDesktopWindow()) return;
    try {
      const status = await invoke<UpdateStatusPayload>("check_for_update");
      if (status.available && status.version) {
        setUpdate({ version: status.version, notes: status.body ?? "" });
      }
    } catch (checkError) {
      // Offline / GitHub unreachable / updater disabled — stay silent, the
      // button simply never appears.
      console.error("Update check failed", checkError);
    }
  }, []);

  // Check once, a few seconds after launch so it never blocks startup.
  useEffect(() => {
    if (!desktop) return;
    const timer = window.setTimeout(() => {
      void checkForUpdate();
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [checkForUpdate, desktop]);

  // Track download progress emitted from the Rust side.
  useEffect(() => {
    if (!desktop) return;
    let unlisten: UnlistenFn | null = null;
    void listen<number>("update-download-progress", (event) => {
      setProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [desktop]);

  const installUpdate = useCallback(async () => {
    if (!update || busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setProgress(0);
    setPhase("downloading");
    try {
      await invoke("download_and_install_update");
      setPhase("installing");
      await invoke("restart_app");
    } catch (installError) {
      busyRef.current = false;
      setPhase("available");
      setError(
        installError instanceof Error
          ? installError.message
          : String(installError),
      );
    }
  }, [update]);

  const dismiss = useCallback(() => {
    setUpdate(null);
    setPhase("idle");
    setError(null);
  }, []);

  return { update, phase, progress, error, checkForUpdate, installUpdate, dismiss };
}
