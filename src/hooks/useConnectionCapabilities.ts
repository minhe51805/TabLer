import { useEffect, useState } from "react";
import type { DriverCapabilityProfile } from "../types";
import { invokeWithTimeout } from "../utils/tauri-utils";

const capabilityCache = new Map<string, DriverCapabilityProfile>();

export function useConnectionCapabilities(connectionId: string | null | undefined) {
  const [profile, setProfile] = useState<DriverCapabilityProfile | null>(() =>
    connectionId ? capabilityCache.get(connectionId) ?? null : null,
  );

  useEffect(() => {
    if (!connectionId) {
      setProfile(null);
      return;
    }
    const cached = capabilityCache.get(connectionId);
    if (cached) {
      setProfile(cached);
      return;
    }

    let cancelled = false;
    setProfile(null);
    void invokeWithTimeout<DriverCapabilityProfile>(
      "get_connection_capabilities",
      { connectionId },
      10_000,
      "Loading database capabilities",
    ).then((nextProfile) => {
      capabilityCache.set(connectionId, nextProfile);
      if (!cancelled) setProfile(nextProfile);
    }).catch(() => {
      if (!cancelled) setProfile(null);
    });

    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  return profile;
}

export function invalidateConnectionCapabilities(connectionId?: string) {
  if (connectionId) capabilityCache.delete(connectionId);
  else capabilityCache.clear();
}
