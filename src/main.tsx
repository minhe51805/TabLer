import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/boot-failure.css";

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

function BootFailureScreen({ failure }: { failure: BootFailureSnapshot }) {
  return (
    <div className="boot-failure-screen">
      <div className="boot-failure-card">
        <div className="boot-failure-kicker">Startup Error</div>
        <h1 className="boot-failure-title">TableR failed to start</h1>
        <p className="boot-failure-description">
          The release build hit a runtime error before the main UI could render.
        </p>

        <div className="boot-failure-error-box">
          {failure.message}
        </div>

        <div className="boot-failure-meta">
          <span>Source: {failure.source}</span>
          <span>At: {failure.at}</span>
        </div>

        {failure.stack ? (
          <pre className="boot-failure-stack">
            {failure.stack}
          </pre>
        ) : null}
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

async function startApp() {
  try {
    if (import.meta.env.MODE === "e2e") {
      await import("@wdio/tauri-plugin");
    }
    window.__TABLER_SET_BOOT_STATUS__?.("Importing App module...", "warning");
    const module = await import("./App");
    clearPersistedBootFailure();
    (globalThis as TablerBootGlobal).__TABLER_HIDE_BOOT_SCREEN__?.();
    window.__TABLER_SET_BOOT_STATUS__?.("Rendering React tree...");

    root.render(
      <React.StrictMode>
        <module.default />
      </React.StrictMode>,
    );
    // After 2 seconds, consider it successfully booted and prevent future errors from turning into boot failures
    setTimeout(() => {
      isAppBooted = true;
    }, 2000);
  } catch (error) {
    renderBootFailure("boot.import", error);
  }
}

// Log boot start
window.__TABLER_SET_BOOT_STATUS__?.("Starting TableR...");
void startApp();
