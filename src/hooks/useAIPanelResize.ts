import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

export const AI_PANEL_MIN_WIDTH = 360;
export const AI_PANEL_MAX_WIDTH = 800;
export const AI_PANEL_DEFAULT_WIDTH = 448;
export const AI_PANEL_WIDTH_STORAGE_KEY = "tabler.ai.panelWidth.v1";

const DESKTOP_RESERVED_WIDTH = 280;
const OVERLAY_BREAKPOINT = 960;
const OVERLAY_RESERVED_WIDTH = 12;

function viewportWidth(): number {
  return typeof window === "undefined" ? 1440 : window.innerWidth;
}

export function clampAIPanelWidth(width: number, viewWidth = viewportWidth()): number {
  if (!Number.isFinite(width)) return AI_PANEL_DEFAULT_WIDTH;
  const reserved = viewWidth <= OVERLAY_BREAKPOINT ? OVERLAY_RESERVED_WIDTH : DESKTOP_RESERVED_WIDTH;
  const maxForViewport = Math.max(AI_PANEL_MIN_WIDTH, viewWidth - reserved);
  const maxWidth = Math.min(AI_PANEL_MAX_WIDTH, maxForViewport);
  return Math.max(AI_PANEL_MIN_WIDTH, Math.min(maxWidth, Math.round(width)));
}

export function readStoredAIPanelWidth(): number {
  if (typeof window === "undefined") return AI_PANEL_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(AI_PANEL_WIDTH_STORAGE_KEY);
    if (!raw) return AI_PANEL_DEFAULT_WIDTH;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return AI_PANEL_DEFAULT_WIDTH;
    return clampAIPanelWidth(parsed);
  } catch {
    return AI_PANEL_DEFAULT_WIDTH;
  }
}

export function persistAIPanelWidth(width: number): number {
  const next = clampAIPanelWidth(width);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(AI_PANEL_WIDTH_STORAGE_KEY, String(next));
    } catch {
      /* ignore quota / private mode */
    }
  }
  return next;
}

interface UseAIPanelResizeOptions {
  enabled?: boolean;
  width: number;
  setWidth: (width: number | ((current: number) => number)) => void;
}

export function useAIPanelResize({ enabled = true, width, setWidth }: UseAIPanelResizeOptions) {
  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  const widthRef = useRef(width);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent) => {
      if (!enabled || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      isResizingRef.current = true;
      startXRef.current = event.clientX;
      startWidthRef.current = widthRef.current;
      document.body.classList.add("is-ai-panel-resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [enabled],
  );

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!isResizingRef.current) return;
      setWidth(clampAIPanelWidth(startWidthRef.current - (event.clientX - startXRef.current)));
    };

    const stopResize = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      document.body.classList.remove("is-ai-panel-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", stopResize);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", stopResize);
      document.body.classList.remove("is-ai-panel-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [setWidth]);

  useEffect(() => {
    if (!enabled) return;
    const handleWindowResize = () => {
      setWidth((current) => clampAIPanelWidth(current));
    };
    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [enabled, setWidth]);

  return handleResizeStart;
}
