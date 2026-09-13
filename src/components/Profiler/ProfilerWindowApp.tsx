/**
 * Standalone root for the detached Profiler window.
 *
 * `main.tsx` mounts this instead of the full <App /> when the window is opened
 * with `?window=profiler`, so the detached window stays lightweight: it does not
 * boot the workspace shell, connection store, or window-profile sync (which all
 * target the main window). It only re-applies the persisted theme's CSS
 * variables and renders the profiler filling the whole native window.
 */

import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "../../stores/useTheme";
import { ProfilerModal } from "./ProfilerModal";
import "../../index.css";
import "../../App.css";

const UI_FONT_SCALE_STORAGE_KEY = "tabler.uiFontScale";

export function ProfilerWindowApp() {
  // Applies the shared, persisted theme (read from localStorage, which is shared
  // across all windows of the same origin) to this window on mount.
  useTheme();

  useEffect(() => {
    const stored = window.localStorage.getItem(UI_FONT_SCALE_STORAGE_KEY);
    const scale = stored ? Number(stored) : NaN;
    if (Number.isFinite(scale) && scale > 0) {
      document.documentElement.style.fontSize = `${scale}%`;
    }
  }, []);

  const params = new URLSearchParams(window.location.search);
  const connectionId = params.get("connectionId") ?? "";
  const connectionName = params.get("connectionName") ?? "";

  const handleClose = () => {
    void getCurrentWindow()
      .close()
      .catch((error) => console.error("Failed to close profiler window", error));
  };

  return (
    <ProfilerModal
      variant="standalone"
      connectionId={connectionId}
      connectionName={connectionName}
      onClose={handleClose}
    />
  );
}
