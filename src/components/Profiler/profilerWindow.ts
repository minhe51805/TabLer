/**
 * Opens the Live Profiler in a detached native window.
 *
 * The profiler used to render as an in-app modal (portalled into the main
 * window), which meant it could never leave the app frame. Here we spawn a real
 * `WebviewWindow` that loads the same frontend bundle with `?window=profiler`
 * so `main.tsx` boots straight into the standalone profiler root. The backend
 * connection pools live in the shared Rust process, so the detached window can
 * drive the same `connectionId` through the normal command path.
 */

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit } from "@tauri-apps/api/event";
import { isTauriDesktopWindow } from "../../hooks/useDesktopWindow";

export const PROFILER_WINDOW_LABEL = "profiler";

/**
 * Global (cross-window) Tauri event fired by the main window when a database
 * connection is dropped. The profiler — whether it lives in the detached native
 * window or the in-app modal — listens for it and closes itself when the closed
 * connection is the one it was tracking, so it never lingers on a dead session
 * showing "connection not found. Please connect first.".
 */
export const PROFILER_CONNECTION_CLOSED_EVENT = "profiler:connection-closed";

/**
 * Default geometry for the detached profiler window. Centralized (rather than
 * inlined at the `new WebviewWindow(...)` call) so the initial size and the
 * minimum size the user can shrink to stay in one obvious place.
 */
const PROFILER_WINDOW_GEOMETRY = {
  width: 1100,
  height: 720,
  minWidth: 720,
  minHeight: 460,
} as const;

/**
 * Notifies any open profiler that the given connection has been disconnected.
 * Safe no-op outside the Tauri desktop shell (the web build's in-app modal
 * already unmounts when the active connection is cleared).
 */
export async function notifyProfilerConnectionClosed(connectionId: string): Promise<void> {
  if (!isTauriDesktopWindow()) return;
  try {
    await emit(PROFILER_CONNECTION_CLOSED_EVENT, { connectionId });
  } catch (error) {
    console.error("Failed to notify profiler of a closed connection", error);
  }
}

export async function openProfilerWindow(
  connectionId: string,
  connectionName: string,
): Promise<boolean> {
  // Only meaningful inside the Tauri desktop shell — the caller falls back to an
  // in-app modal on the web build.
  if (!isTauriDesktopWindow()) return false;

  // Reuse a single profiler window: if one is already open, just surface it.
  try {
    const existing = await WebviewWindow.getByLabel(PROFILER_WINDOW_LABEL);
    if (existing) {
      await existing.unminimize().catch(() => {});
      await existing.setFocus().catch(() => {});
      return true;
    }
  } catch (error) {
    console.error("Failed to look up existing profiler window", error);
  }

  const params = new URLSearchParams({
    window: "profiler",
    connectionId,
    connectionName,
  });

  const profilerWindow = new WebviewWindow(PROFILER_WINDOW_LABEL, {
    url: `index.html?${params.toString()}`,
    title: `Profiler — ${connectionName}`,
    ...PROFILER_WINDOW_GEOMETRY,
    resizable: true,
    maximizable: true,
    minimizable: true,
    decorations: false,
    center: true,
  });

  profilerWindow.once("tauri://error", (event) => {
    console.error("Failed to open profiler window", event.payload);
  });

  return true;
}
