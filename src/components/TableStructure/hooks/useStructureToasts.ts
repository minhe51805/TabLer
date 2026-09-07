import { useCallback, useRef, useState } from "react";

type StructureToastTone = "success" | "info" | "error";

interface StructureToast {
  id: number;
  tone: StructureToastTone;
  title: string;
  description?: string;
  isClosing: boolean;
}

/**
 * Timed toast lifecycle for structure operations: show -> auto-hide (3.2s)
 * -> unmount (3.44s), with manual dismiss and timer cleanup.
 */
export function useStructureToasts() {
  const [toast, setToast] = useState<StructureToast | null>(null);
  const toastIdRef = useRef(0);
  const toastHideTimeoutRef = useRef<number | null>(null);
  const toastClearTimeoutRef = useRef<number | null>(null);

  const clearToastTimers = useCallback(() => {
    if (toastHideTimeoutRef.current !== null) {
      window.clearTimeout(toastHideTimeoutRef.current);
      toastHideTimeoutRef.current = null;
    }
    if (toastClearTimeoutRef.current !== null) {
      window.clearTimeout(toastClearTimeoutRef.current);
      toastClearTimeoutRef.current = null;
    }
  }, []);

  const dismissToast = useCallback(() => {
    clearToastTimers();
    setToast((prev) => (prev ? { ...prev, isClosing: true } : prev));
    toastClearTimeoutRef.current = window.setTimeout(() => {
      setToast(null);
      toastClearTimeoutRef.current = null;
    }, 220);
  }, [clearToastTimers]);

  const showToast = useCallback(
    (tone: StructureToastTone, title: string, description?: string) => {
      clearToastTimers();
      const toastId = ++toastIdRef.current;

      setToast({
        id: toastId,
        tone,
        title,
        description,
        isClosing: false,
      });

      toastHideTimeoutRef.current = window.setTimeout(() => {
        setToast((prev) => (prev?.id === toastId ? { ...prev, isClosing: true } : prev));
        toastHideTimeoutRef.current = null;
      }, 3200);

      toastClearTimeoutRef.current = window.setTimeout(() => {
        setToast((prev) => (prev?.id === toastId ? null : prev));
        toastClearTimeoutRef.current = null;
      }, 3440);
    },
    [clearToastTimers]
  );

  return {
    toast,
    showToast,
    dismissToast,
    clearToastTimers,
  };
}
