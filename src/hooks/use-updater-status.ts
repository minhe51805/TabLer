import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

/** Payload returned by the `check_for_update` Tauri command. */
export interface UpdateStatusPayload {
  available: boolean;
  version: string | null;
  body: string | null;
}

export type UpdaterAvailability = "unknown" | "enabled" | "disabled";

export interface UpdateCheckOutcome {
  kind: "never" | "upToDate" | "available" | "failed";
  /** Version of the available update, when `kind === "available"`. */
  version?: string;
}

const isDesktopWindow = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Updater status for the About modal: whether the updater plugin is
 * configured (`updater_enabled` command) and the outcome of the last manual
 * check. The probe is silent-fail-safe — a missing command or backend error
 * leaves the availability as "unknown" instead of throwing.
 */
export function useUpdaterStatus() {
  const [availability, setAvailability] = useState<UpdaterAvailability>("unknown");
  const [outcome, setOutcome] = useState<UpdateCheckOutcome>({ kind: "never" });

  useEffect(() => {
    if (!isDesktopWindow()) {
      // Browser/dev preview: no updater plugin exists at all.
      setAvailability("disabled");
      return;
    }
    let cancelled = false;
    invoke<boolean>("updater_enabled")
      .then((enabled) => {
        if (!cancelled) setAvailability(enabled ? "enabled" : "disabled");
      })
      .catch(() => {
        if (!cancelled) setAvailability("unknown");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Record the result of a manual check (`null` = the invoke threw).
  const reportCheck = useCallback((status: UpdateStatusPayload | null) => {
    if (!status) {
      setOutcome({ kind: "failed" });
      return;
    }
    // A successful check proves the updater is configured.
    setAvailability("enabled");
    setOutcome(
      status.available
        ? { kind: "available", version: status.version ?? undefined }
        : { kind: "upToDate" },
    );
  }, []);

  return { availability, outcome, reportCheck };
}
