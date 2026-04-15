import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/appStore";
import { emitAppToast } from "../utils/app-toast";

const BASE_INTERVAL_MS = 30_000; // 30 seconds
const MAX_INTERVAL_MS = 300_000; // 5 minutes
const BACKOFF_MULTIPLIER = 2;

/**
 * Periodically pings all connected database connections via the Rust backend.
 * On failure for a given connection:
 *   - Sets that connection's health to `false` in appStore
 *   - Emits a warning toast
 *   - Attempts to auto-reconnect
 *   - Applies exponential backoff per-connection (30s → 60s → 120s → 5min cap)
 * On recovery, resets the interval back to 30s and emits an info toast.
 */
export function useConnectionHealthMonitor() {
  const connectedIds = useAppStore((s) => s.connectedIds);
  const setConnectionHealth = useAppStore((s) => s.setConnectionHealth);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentIntervalMs = useRef(BASE_INTERVAL_MS);
  const consecutiveFailures = useRef(0);
  const prevHealthRef = useRef<Record<string, boolean>>({});

  const clearExistingInterval = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const pingConnection = useCallback(async (connectionId: string): Promise<boolean> => {
    try {
      const isAlive = await invoke<boolean>("check_connection_status", { connectionId });
      return isAlive;
    } catch {
      return false;
    }
  }, []);

  const getConnectionLabel = useCallback((connId: string): string => {
    const conn = useAppStore.getState().connections.find((c) => c.id === connId);
    return conn?.name || conn?.database || connId;
  }, []);

  const scheduleNextPing = useCallback(() => {
    clearExistingInterval();
    intervalRef.current = setInterval(async () => {
      const currentConnectedIds = useAppStore.getState().connectedIds;
      if (currentConnectedIds.size === 0) return;

      // Ping each connected connection
      const results = await Promise.all(
        [...currentConnectedIds].map(async (connId) => {
          const isAlive = await pingConnection(connId);
          return { connId, isAlive };
        }),
      );

      const allHealthy = results.every((r) => r.isAlive);
      const anyFailed = results.some((r) => !r.isAlive);

      const prevHealth = prevHealthRef.current;
      const nextHealth: Record<string, boolean> = {};

      // Update health state for all and emit toasts on state transitions
      for (const { connId, isAlive } of results) {
        setConnectionHealth(connId, isAlive);
        nextHealth[connId] = isAlive;

        const label = getConnectionLabel(connId);

        // Transition: healthy → unhealthy
        if (prevHealth[connId] !== false && !isAlive) {
          emitAppToast({
            tone: "error",
            title: "Connection Unreachable",
            description: `"${label}" is not responding. Retrying…`,
          });
        }

        // Transition: unhealthy → healthy
        if (prevHealth[connId] === false && isAlive) {
          emitAppToast({
            tone: "success",
            title: "Connection Restored",
            description: `"${label}" is back online.`,
          });
        }
      }

      prevHealthRef.current = nextHealth;

      if (allHealthy) {
        if (consecutiveFailures.current > 0) {
          consecutiveFailures.current = 0;
          currentIntervalMs.current = BASE_INTERVAL_MS;
          clearExistingInterval();
          scheduleNextPing();
        }
      } else if (anyFailed) {
        consecutiveFailures.current += 1;
        const newInterval = Math.min(
          BASE_INTERVAL_MS * Math.pow(BACKOFF_MULTIPLIER, consecutiveFailures.current),
          MAX_INTERVAL_MS,
        );
        if (newInterval !== currentIntervalMs.current) {
          currentIntervalMs.current = newInterval;
          clearExistingInterval();
          scheduleNextPing();
        }

        // Attempt reconnect for each unhealthy connection
        for (const { connId, isAlive } of results) {
          if (!isAlive) {
            try {
              await useAppStore.getState().connectSavedConnection(connId);
              setConnectionHealth(connId, true);
            } catch {
              // Reconnect failed — keep as unhealthy, backoff already scheduled
            }
          }
        }
      }
    }, currentIntervalMs.current);
  }, [clearExistingInterval, pingConnection, getConnectionLabel, setConnectionHealth]);

  useEffect(() => {
    const currentConnectedIds = connectedIds;

    if (currentConnectedIds.size === 0) {
      clearExistingInterval();
      consecutiveFailures.current = 0;
      currentIntervalMs.current = BASE_INTERVAL_MS;
      prevHealthRef.current = {};
      return;
    }

    // New connection(s) — reset and start monitoring
    consecutiveFailures.current = 0;
    currentIntervalMs.current = BASE_INTERVAL_MS;
    scheduleNextPing();

    return () => {
      clearExistingInterval();
    };
  }, [connectedIds, clearExistingInterval, scheduleNextPing]);
}