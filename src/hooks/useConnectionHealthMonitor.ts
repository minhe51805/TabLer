import { useEffect, useRef, useCallback } from "react";
import { useConnectionStore } from "../stores/connectionStore";
import { emitAppToast } from "../utils/app-toast";
import { invokeWithTimeout } from "../utils/tauri-utils";

const BASE_INTERVAL_MS = 30_000; // 30 seconds
const MAX_INTERVAL_MS = 300_000; // 5 minutes
const BACKOFF_MULTIPLIER = 2;
const PING_TIMEOUT_MS = 5_000;

/**
 * Periodically pings all connected database connections via the Rust backend.
 * On failure for a given connection:
 *   - Sets that connection's health to `false` in connectionStore
 *   - Emits an error toast telling the user to reconnect manually
 *   - Applies exponential backoff (30s → 60s → 120s → 5min cap)
 * On recovery, resets the interval back to 30s and emits an info toast.
 *
 * Design notes (freeze prevention):
 *   - Recursive `setTimeout` + an in-flight guard: a slow ping can never make
 *     ticks pile up on top of each other like a raw `setInterval` would.
 *   - Each ping has a hard timeout, so a black-holed connection cannot leave
 *     a check hanging forever.
 *   - No automatic reconnection: replacing a live driver under the user's
 *     feet killed in-flight queries and kicked the whole workspace back to
 *     the launcher. Reconnecting is always a user action.
 */
export function useConnectionHealthMonitor() {
  const connectedIds = useConnectionStore((s) => s.connectedIds);
  const setConnectionHealth = useConnectionStore((s) => s.setConnectionHealth);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const currentIntervalMs = useRef(BASE_INTERVAL_MS);
  const consecutiveFailures = useRef(0);
  const prevHealthRef = useRef<Record<string, boolean>>({});

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const pingConnection = useCallback(async (connectionId: string): Promise<boolean> => {
    try {
      return await invokeWithTimeout<boolean>(
        "check_connection_status",
        { connectionId },
        PING_TIMEOUT_MS,
        "Connection health check",
      );
    } catch {
      return false;
    }
  }, []);

  const getConnectionLabel = useCallback((connId: string): string => {
    const conn = useConnectionStore.getState().connections.find((c) => c.id === connId);
    return conn?.name || conn?.database || connId;
  }, []);

  const scheduleNextPing = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      void runPingCycleRef.current();
    }, currentIntervalMs.current);
  }, [clearTimer]);

  const runPingCycle = useCallback(async () => {
    // Overlap guard: never let a slow cycle stack a second one on top.
    if (inFlightRef.current) {
      scheduleNextPing();
      return;
    }
    inFlightRef.current = true;
    try {
      const currentConnectedIds = useConnectionStore.getState().connectedIds;
      if (currentConnectedIds.size === 0) return;

      // Ping each connected connection (hard per-ping timeout above)
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
            description: `"${label}" is not responding. Reconnect from the sidebar.`,
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
        consecutiveFailures.current = 0;
        currentIntervalMs.current = BASE_INTERVAL_MS;
      } else if (anyFailed) {
        consecutiveFailures.current += 1;
        currentIntervalMs.current = Math.min(
          BASE_INTERVAL_MS * Math.pow(BACKOFF_MULTIPLIER, consecutiveFailures.current),
          MAX_INTERVAL_MS,
        );
      }
    } finally {
      inFlightRef.current = false;
      scheduleNextPing();
    }
  }, [getConnectionLabel, pingConnection, scheduleNextPing, setConnectionHealth]);

  // Keep the scheduling closure pointing at the latest cycle runner without
  // retriggering the monitor effect on every identity change.
  const runPingCycleRef = useRef(runPingCycle);
  useEffect(() => {
    runPingCycleRef.current = runPingCycle;
  }, [runPingCycle]);

  useEffect(() => {
    if (connectedIds.size === 0) {
      clearTimer();
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
      clearTimer();
    };
  }, [connectedIds, clearTimer, scheduleNextPing]);
}

