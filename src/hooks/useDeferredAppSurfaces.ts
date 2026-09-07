import { useEffect, useState } from "react";

const GLOBAL_MODAL_IDLE_MOUNT_MS = 1200;

export function useDeferredAppSurfaces(
  showAIWorkspace: boolean,
  shouldMountGlobalModals: boolean,
) {
  const [hasMountedAIWorkspace, setHasMountedAIWorkspace] = useState(false);
  const [hasMountedGlobalModals, setHasMountedGlobalModals] = useState(false);

  useEffect(() => {
    if (showAIWorkspace) setHasMountedAIWorkspace(true);
  }, [showAIWorkspace]);

  useEffect(() => {
    if (hasMountedGlobalModals) return;
    if (shouldMountGlobalModals) {
      setHasMountedGlobalModals(true);
      return;
    }
    const timeoutId = window.setTimeout(
      () => setHasMountedGlobalModals(true),
      GLOBAL_MODAL_IDLE_MOUNT_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [hasMountedGlobalModals, shouldMountGlobalModals]);

  return { hasMountedAIWorkspace, hasMountedGlobalModals };
}
