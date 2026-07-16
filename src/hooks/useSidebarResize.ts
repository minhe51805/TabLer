import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

export const SIDEBAR_MIN_WIDTH = 300;
export const SIDEBAR_MAX_WIDTH = 460;

interface UseSidebarResizeOptions {
  isCollapsed: boolean;
  width: number;
  setWidth: (width: number) => void;
}

export function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width));
}

export function useSidebarResize({ isCollapsed, width, setWidth }: UseSidebarResizeOptions) {
  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent) => {
      if (isCollapsed) return;

      isResizingRef.current = true;
      startXRef.current = event.clientX;
      startWidthRef.current = width;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [isCollapsed, width],
  );

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!isResizingRef.current) return;
      setWidth(clampSidebarWidth(startWidthRef.current + event.clientX - startXRef.current));
    };

    const handleMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [setWidth]);

  useEffect(() => {
    if (!isCollapsed && width < SIDEBAR_MIN_WIDTH) {
      setWidth(SIDEBAR_MIN_WIDTH);
    }
  }, [isCollapsed, setWidth, width]);

  return handleResizeStart;
}
