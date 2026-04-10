import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/appStore";

const BASE_INTERVAL_MS = 30_000; // 30 seconds
const MAX_INTERVAL_MS = 300_000; // 5 minutes
const BACKOFF_MULTIPLIER = 2;

/**
 * Periodically pings the active database connection via the Rust backend.
 * On failure, sets `connectionHealthy = false` in appStore, attempts to
 * auto-reconnect, and applies exponential backoff (30s → 60s → 120s → 5min cap).
 * On recovery, resets the interval back to 30s.
 */
export function useConnectionHealthMonitor() {
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const connectedIds = useAppStore((s) => s.connectedIds);
  const setConnectionHealthy = useAppStore((s) => s.setConnectionHealthy);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentIntervalMs = useRef(BASE_INTERVAL_MS);
  const consecutiveFailures = useRef(0);

  const clearExistingInterval = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const scheduleNextPing = useCallback(() => {
    clearExistingInterval();
    intervalRef.current = setInterval(async () => {
      const connectionId = useAppStore.getState().activeConnectionId;
      if (!connectionId) return;

      try {
        const isAlive = await invoke<boolean>("check_connection_status", {
          connectionId,
        });

        if (isAlive) {
          // Recovered or still healthy
          if (consecutiveFailures.current > 0) {
            consecutiveFailures.current = 0;
            currentIntervalMs.current = BASE_INTERVAL_MS;
            // Reschedule at base interval
            clearExistingInterval();
            scheduleNextPing();
          }
          setConnectionHealthy(true);
        } else {
          throw new Error("Connection dead");
        }
      } catch {
        // Ping failed, attempt auto-reconnect
        setConnectionHealthy(false);
        try {
          // Attempt to reconnect using the saved connection config
          await useAppStore.getState().connectSavedConnection(connectionId);
          // If successful, connection is restored
          consecutiveFailures.current = 0;
          currentIntervalMs.current = BASE_INTERVAL_MS;
          setConnectionHealthy(true);
          clearExistingInterval();
          scheduleNextPing();
          return;
        } catch (reconnectError) {
          // Reconnect failed, apply exponential backoff
          consecutiveFailures.current += 1;

          const newInterval = Math.min(
            BASE_INTERVAL_MS * Math.pow(BACKOFF_MULTIPLIER, consecutiveFailures.current),
            MAX_INTERVAL_MS
          );
          if (newInterval !== currentIntervalMs.current) {
            currentIntervalMs.current = newInterval;
            clearExistingInterval();
            scheduleNextPing();
          }
        }
      }
    }, currentIntervalMs.current);
  }, [clearExistingInterval, setConnectionHealthy]);

  useEffect(() => {
    // Only monitor when we have an active connection that's in connectedIds
    if (!activeConnectionId || !connectedIds.has(activeConnectionId)) {
      clearExistingInterval();
      // Reset state when no connection
      consecutiveFailures.current = 0;
      currentIntervalMs.current = BASE_INTERVAL_MS;
      setConnectionHealthy(true);
      return;
    }

    // New connection — reset and start monitoring
    consecutiveFailures.current = 0;
    currentIntervalMs.current = BASE_INTERVAL_MS;
    setConnectionHealthy(true);
    scheduleNextPing();

    return () => {
      clearExistingInterval();
    };
  }, [activeConnectionId, connectedIds, clearExistingInterval, setConnectionHealthy, scheduleNextPing]);
}
