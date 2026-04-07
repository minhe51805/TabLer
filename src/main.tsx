import React from "react";
import ReactDOM from "react-dom/client";

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
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background:
          "radial-gradient(circle at top, rgba(0,212,170,0.08), transparent 28%), #090d14",
        color: "#e7edf7",
        fontFamily: "Segoe UI, Inter, system-ui, sans-serif",
        padding: "24px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: "min(760px, 100%)",
          borderRadius: "18px",
          border: "1px solid rgba(0,212,170,0.18)",
          background: "rgba(10, 16, 26, 0.96)",
          boxShadow: "0 24px 60px rgba(0, 0, 0, 0.38)",
          padding: "24px",
        }}
      >
        <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#00d4aa" }}>
          Startup Error
        </div>
        <h1 style={{ margin: "12px 0 8px", fontSize: "28px", lineHeight: 1.15 }}>
          TableR failed to start
        </h1>
        <p style={{ margin: 0, color: "#9fb0c8", lineHeight: 1.6 }}>
          The release build hit a runtime error before the main UI could render.
        </p>

        <div
          style={{
            marginTop: "18px",
            padding: "14px 16px",
            borderRadius: "14px",
            background: "rgba(71, 16, 16, 0.56)",
            border: "1px solid rgba(255, 120, 120, 0.18)",
            color: "#ffd4d4",
            fontSize: "14px",
            lineHeight: 1.6,
            wordBreak: "break-word",
          }}
        >
          {failure.message}
        </div>

        <div
          style={{
            marginTop: "14px",
            display: "flex",
            gap: "10px",
            flexWrap: "wrap",
            color: "#8ea4c3",
            fontSize: "12px",
          }}
        >
          <span>Source: {failure.source}</span>
          <span>At: {failure.at}</span>
        </div>

        {failure.stack ? (
          <pre
            style={{
              marginTop: "18px",
              padding: "16px",
              borderRadius: "14px",
              background: "rgba(6, 10, 18, 0.92)",
              border: "1px solid rgba(111, 147, 190, 0.18)",
              color: "#bcd0eb",
              fontSize: "12px",
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflow: "auto",
              maxHeight: "42vh",
            }}
          >
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

function renderBootFailure(source: string, error: unknown) {
  if (bootFailureShown) return;
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
    // Log what modules are being loaded to help debug
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
  } catch (error) {
    renderBootFailure("boot.import", error);
  }
}

// Log boot start
window.__TABLER_SET_BOOT_STATUS__?.("Starting TableR...");
void startApp();
