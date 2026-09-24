import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useSyncExternalStore } from "react";

export type AppUpdatePhase = "idle" | "checking" | "available" | "downloading" | "installing";

export interface AppUpdateInfo {
  version: string;
  notes: string;
}

interface UpdateStatusPayload {
  available: boolean;
  version: string | null;
  body: string | null;
}

interface AppUpdaterState {
  update: AppUpdateInfo | null;
  phase: AppUpdatePhase;
  progress: number;
  /** Install/download failure, shown inside the update popup. */
  error: string | null;
  /** Background check failure — the pill renders a quiet retry state. */
  checkError: string | null;
}

const isDesktopWindow = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Minimum gap between automatic checks. The pill mounts in both the startup
 * manager and the workspace titlebar — without this every mount fired its own
 * `check_for_update` invoke.
 */
const AUTO_CHECK_MIN_INTERVAL_MS = 60_000;
const AUTO_CHECK_DELAY_MS = 2_500;

// ─── Shared module-level store ───────────────────────────────────────────────
// `useAppUpdater` is consumed by every mounted `AppUpdateButton`; keeping the
// state in one store means a single check/install lifecycle no matter how many
// pills are on screen, and a check failure is visible everywhere.

let state: AppUpdaterState = {
  update: null,
  phase: "idle",
  progress: 0,
  error: null,
  checkError: null,
};

const listeners = new Set<() => void>();
let progressUnlisten: UnlistenFn | null = null;
let checkInFlight: Promise<void> | null = null;
let lastCheckAt = 0;
let autoCheckTimer: number | null = null;
let installBusy = false;

function setState(patch: Partial<AppUpdaterState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    attachProgressListener();
    scheduleAutoCheck();
  }
  return () => {
    listeners.delete(listener);
  };
}

function attachProgressListener() {
  if (!isDesktopWindow() || progressUnlisten) return;
  void listen<number>("update-download-progress", (event) => {
    setState({ progress: event.payload });
  }).then((fn) => {
    progressUnlisten = fn;
  });
}

function scheduleAutoCheck() {
  if (!isDesktopWindow() || autoCheckTimer !== null) return;
  autoCheckTimer = window.setTimeout(() => {
    autoCheckTimer = null;
    void requestUpdateCheck();
  }, AUTO_CHECK_DELAY_MS);
}

async function requestUpdateCheck(options?: { force?: boolean }): Promise<void> {
  if (!isDesktopWindow()) return;
  if (checkInFlight) return checkInFlight;
  if (!options?.force && Date.now() - lastCheckAt < AUTO_CHECK_MIN_INTERVAL_MS) {
    return;
  }
  lastCheckAt = Date.now();
  checkInFlight = (async () => {
    setState({ phase: "checking" });
    try {
      const status = await invoke<UpdateStatusPayload>("check_for_update");
      if (status.available && status.version) {
        setState({
          update: { version: status.version, notes: status.body ?? "" },
          phase: "available",
          checkError: null,
        });
      } else {
        setState({ update: null, phase: "idle", checkError: null });
      }
    } catch (checkError) {
      // Offline / GitHub unreachable / updater disabled — surface a quiet
      // retry affordance instead of the button silently never appearing.
      console.error("Update check failed", checkError);
      setState({
        phase: "idle",
        checkError: checkError instanceof Error ? checkError.message : String(checkError),
      });
    } finally {
      checkInFlight = null;
    }
  })();
  return checkInFlight;
}

async function requestInstall(): Promise<void> {
  if (!state.update || installBusy) return;
  installBusy = true;
  setState({ error: null, progress: 0, phase: "downloading" });
  try {
    await invoke("download_and_install_update");
    setState({ phase: "installing" });
    await invoke("restart_app");
  } catch (installError) {
    installBusy = false;
    setState({
      phase: "available",
      error: installError instanceof Error ? installError.message : String(installError),
    });
  }
}

/**
 * In-app update lifecycle: check for a newer release shortly after mount,
 * expose the found version/notes plus a retryable check-failure state, then
 * download + install + relaunch on demand. Backed by the Tauri updater plugin
 * via the app's own commands (check_for_update /
 * download_and_install_update / restart_app).
 */
export function useAppUpdater() {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );

  const checkForUpdate = useCallback(() => requestUpdateCheck({ force: true }), []);
  const installUpdate = useCallback(() => requestInstall(), []);
  const dismiss = useCallback(() => {
    setState({ update: null, phase: "idle", error: null });
  }, []);

  return {
    update: snapshot.update,
    phase: snapshot.phase,
    progress: snapshot.progress,
    error: snapshot.error,
    checkError: snapshot.checkError,
    checkForUpdate,
    installUpdate,
    dismiss,
  };
}

/**
 * Version string shown to the user. The updater manifest `version` is the
 * semver bundle version (0.1.6) while releases carry a letter-suffixed label
 * (v0.1.6b); the release notes' first heading carries that label, so prefer it
 * when present and fall back to the manifest version otherwise.
 */
export function updateDisplayVersion(update: AppUpdateInfo): string {
  const match = update.notes.match(/v(\d+\.\d+\.\d+[0-9A-Za-z.-]*)/);
  return match?.[1] ?? update.version;
}
