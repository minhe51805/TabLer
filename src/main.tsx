import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/boot-failure.css";
import { invoke } from "@tauri-apps/api/core";
import {
  StorageRecoveryDialog,
  type StorageHealthReport,
} from "./components/StorageRecoveryDialog";

interface BootFailureSnapshot {
  source: string;
  message: string;
  stack?: string;
  at: string;
}

type TablerBootGlobal = typeof globalThis & {
  __TABLER_HIDE_BOOT_SCREEN__?: () => void;
  __TABLER_SET_BOOT_STATUS__?: (message: string, tone?: "warning") => void;
};

declare global {
  interface Window extends TablerBootGlobal {}
}

const BOOT_FAILURE_STORAGE_KEY = "tabler.bootFailure";

function normalizeBootError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || "Unknown startup error",
      stack: error.stack,
    };
  }

  if (typeof error === "string") {
    return { message: error };
  }

  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error ?? "Unknown startup error") };
  }
}

function persistBootFailure(snapshot: BootFailureSnapshot) {
  try {
    window.localStorage.setItem(BOOT_FAILURE_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore storage failures in boot diagnostics.
  }
}

function clearPersistedBootFailure() {
  try {
    window.localStorage.removeItem(BOOT_FAILURE_STORAGE_KEY);
  } catch {
    // Ignore storage failures in boot diagnostics.
  }
}

// Entry-point-only error screen; moving it out of main.tsx is churn for
// fast-refresh that never applies to the boot failure path.
// eslint-disable-next-line react-refresh/only-export-components
function BootFailureScreen({ failure }: { failure: BootFailureSnapshot }) {
  return (
    <div className="boot-failure-screen">
      <div className="boot-failure-card">
        <div className="boot-failure-kicker">Startup Error</div>
        <h1 className="boot-failure-title">TableR failed to start</h1>
        <p className="boot-failure-description">
          The release build hit a runtime error before the main UI could render.
        </p>

        <div className="boot-failure-error-box">{failure.message}</div>

        <div className="boot-failure-meta">
          <span>Source: {failure.source}</span>
          <span>At: {failure.at}</span>
        </div>

        {failure.stack ? <pre className="boot-failure-stack">{failure.stack}</pre> : null}
      </div>
    </div>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element '#root' was not found.");
}

const root = ReactDOM.createRoot(rootElement);
let bootFailureShown = false;
let isAppBooted = false;

function renderBootFailure(source: string, error: unknown) {
  if (bootFailureShown) return;
  if (isAppBooted) return; // Do not crash the entire app if it's already booted
  bootFailureShown = true;

  const normalized = normalizeBootError(error);
  const snapshot: BootFailureSnapshot = {
    source,
    message: normalized.message,
    stack: normalized.stack,
    at: new Date().toISOString(),
  };

  persistBootFailure(snapshot);
  console.error("[TableR boot]", source, error);
  (globalThis as TablerBootGlobal).__TABLER_HIDE_BOOT_SCREEN__?.();
  root.render(<BootFailureScreen failure={snapshot} />);
}

window.addEventListener("error", (event) => {
  const err = event.error ?? event.message;
  console.error("[TableR] window.error:", err);
  renderBootFailure("window.error", err);
});

window.addEventListener("unhandledrejection", (event) => {
  const err = event.reason;
  console.error("[TableR] unhandledrejection:", err);
  renderBootFailure("unhandledrejection", err);
});

// Suppress the WebView2/Chromium default right-click menu (Back / Refresh /
// Emoji / Import passwords / Inspect…) EVERYWHERE — including text fields.
// TableR renders its own context menus (DataGrid, Sidebar tree, ERD, Metrics);
// clipboard actions in text fields remain available via Ctrl+C/Ctrl+V.
// Devtools stay reachable via F12 / Ctrl+Shift+I while devtools are enabled.
document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});
// Boot timing: marks land in the performance timeline for devtools and are
// mirrored to the Rust log so release builds can report startup latency.
performance.mark("boot:start");

function reportBootMark(name: string) {
  performance.mark(name);
  const entry = performance.getEntriesByName(name, "mark").pop();
  if (!entry) return;
  console.info(`[TableR boot] ${name} ${entry.startTime.toFixed(1)}ms`);
  if ("__TAURI_INTERNALS__" in window) {
    invoke("log_boot_timing", { mark: name, milliseconds: entry.startTime }).catch(() => {
      // Timing telemetry must never break boot.
    });
  }
}

function reportFirstRender() {
  // Double rAF lands after the first painted frame.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => reportBootMark("boot:first-render"));
  });
}

async function startApp() {
  try {
    // The storage probe only needs to gate the render, not the App chunk
    // fetch/parse — run both concurrently and await the probe before render.
    const healthProbe =
      "__TAURI_INTERNALS__" in window
        ? invoke<StorageHealthReport>("check_storage_health").catch((healthError) => {
            // A failed probe must never block startup — the per-store load errors
            // still surface through the normal error paths.
            console.error("[TableR boot] storage health check failed", healthError);
            return null;
          })
        : Promise.resolve(null);
    if (import.meta.env.MODE === "e2e") {
      await import("@wdio/tauri-plugin");
    }
    window.__TABLER_SET_BOOT_STATUS__?.("Loading application…");
    // Dynamic import is the code-split boundary: a static import would fold
    // the whole workspace into the entry chunk and remove the boot screen's
    // ability to paint before the heavy modules parse.
    const modulePromise = import("./App");
    const report = await healthProbe;
    reportBootMark("boot:health-done");
    if (report && !report.healthy) {
      (globalThis as TablerBootGlobal).__TABLER_HIDE_BOOT_SCREEN__?.();
      root.render(<StorageRecoveryDialog report={report} />);
      return;
    }
    const module = await modulePromise;
    reportBootMark("boot:app-imported");
    clearPersistedBootFailure();
    (globalThis as TablerBootGlobal).__TABLER_HIDE_BOOT_SCREEN__?.();
    window.__TABLER_SET_BOOT_STATUS__?.("Rendering React tree...");

    root.render(
      <React.StrictMode>
        <module.default />
      </React.StrictMode>,
    );
    reportFirstRender();
    prefetchHeavyChunks();

    // After 2 seconds, consider it successfully booted and prevent future errors from turning into boot failures
    setTimeout(() => {
      isAppBooted = true;
    }, 2000);
  } catch (error) {
    renderBootFailure("boot.import", error);
  }
}
function prefetchHeavyChunks() {
  // Monaco is the largest lazy chunk (~3.7 MB). Fetching it while the window
  // is idle makes the first SQL tab open instantly without delaying first
  // paint. The import goes through a shim so Vite keeps vendor-monaco out of
  // index.html's modulepreload list.
  const prefetch = () => {
    import("./utils/monaco-prefetch")
      .then((module) => module.prefetchMonacoBundle())
      .catch(() => {
        // Prefetch failure is harmless — the real import retries on demand.
      });
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(prefetch, { timeout: 4000 });
  } else {
    setTimeout(prefetch, 1500);
  }
}

// Detached Profiler window: opened via `new WebviewWindow(..., "index.html?window=profiler")`.
// It boots straight into the lightweight standalone profiler root instead of the
// full workspace shell, so it never re-runs window-profile sync against the main window.
async function startProfilerWindow() {
  try {
    const { ProfilerWindowApp } = await import("./components/Profiler/ProfilerWindowApp");
    clearPersistedBootFailure();
    (globalThis as TablerBootGlobal).__TABLER_HIDE_BOOT_SCREEN__?.();
    root.render(
      <React.StrictMode>
        <ProfilerWindowApp />
      </React.StrictMode>,
    );
    setTimeout(() => {
      isAppBooted = true;
    }, 2000);
  } catch (error) {
    renderBootFailure("boot.profiler", error);
  }
}

// Log boot start
window.__TABLER_SET_BOOT_STATUS__?.("Starting TableR...");
if (new URLSearchParams(window.location.search).get("window") === "profiler") {
  void startProfilerWindow();
} else {
  void startApp();
}
