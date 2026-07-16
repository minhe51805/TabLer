import { useCallback, useEffect, useRef, useState } from "react";

import { useGlobalErrorStore } from "../stores/globalErrorStore";
import {
  GLOBAL_ERROR_AUTO_DISMISS_MS,
  GLOBAL_TOAST_AUTO_DISMISS_MS,
  GLOBAL_TOAST_EXIT_MS,
  type GlobalToastState,
} from "../types/app-types";
import { APP_TOAST_EVENT, type AppToastPayload } from "../utils/app-toast";

export function normalizeToastDuration(durationMs?: number): number {
  return Math.max(
    durationMs ?? GLOBAL_TOAST_AUTO_DISMISS_MS,
    GLOBAL_TOAST_EXIT_MS + 120,
  );
}

export function useAppNotifications() {
  const error = useGlobalErrorStore((state) => state.error);
  const clearError = useGlobalErrorStore((state) => state.clearError);
  const [toast, setToast] = useState<GlobalToastState | null>(null);
  const toastIdRef = useRef(0);
  const hideTimeoutRef = useRef<number | null>(null);
  const clearTimeoutRef = useRef<number | null>(null);

  const clearToastTimers = useCallback(() => {
    if (hideTimeoutRef.current !== null) {
      window.clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    if (clearTimeoutRef.current !== null) {
      window.clearTimeout(clearTimeoutRef.current);
      clearTimeoutRef.current = null;
    }
  }, []);

  const dismissToast = useCallback(() => {
    clearToastTimers();
    setToast((current) => (current ? { ...current, isClosing: true } : current));
    clearTimeoutRef.current = window.setTimeout(() => {
      setToast(null);
      clearTimeoutRef.current = null;
    }, GLOBAL_TOAST_EXIT_MS);
  }, [clearToastTimers]);

  useEffect(() => {
    if (!error) return;
    const timeoutId = window.setTimeout(clearError, GLOBAL_ERROR_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [clearError, error]);

  useEffect(() => {
    const handleToast = (event: Event) => {
      const detail = (event as CustomEvent<AppToastPayload>).detail;
      if (!detail?.title) return;

      clearToastTimers();
      const toastId = ++toastIdRef.current;
      const durationMs = normalizeToastDuration(detail.durationMs);
      setToast({
        id: toastId,
        tone: detail.tone ?? "info",
        title: detail.title,
        description: detail.description,
        isClosing: false,
      });

      hideTimeoutRef.current = window.setTimeout(() => {
        setToast((current) =>
          current?.id === toastId ? { ...current, isClosing: true } : current,
        );
        hideTimeoutRef.current = null;
      }, durationMs - GLOBAL_TOAST_EXIT_MS);

      clearTimeoutRef.current = window.setTimeout(() => {
        setToast((current) => (current?.id === toastId ? null : current));
        clearTimeoutRef.current = null;
      }, durationMs);
    };

    window.addEventListener(APP_TOAST_EVENT, handleToast);
    return () => {
      clearToastTimers();
      window.removeEventListener(APP_TOAST_EVENT, handleToast);
    };
  }, [clearToastTimers]);

  return { toast, dismissToast };
}
