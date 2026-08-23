import { memo, useEffect, useRef } from "react";
import { useStore } from "@xyflow/react";

export const EDGE_LABEL_MIN_ZOOM = 0.7;

/**
 * Keeps edge labels out of sight when the diagram is zoomed far out.
 *
 * This intentionally avoids per-edge viewport subscriptions (one subscriber
 * instead of one per edge) and toggles a CSS class on the flow root so zoom
 * gestures never re-render edge components.
 */
export const ERDZoomLabelController = memo(function ERDZoomLabelController() {
  const sensorRef = useRef<HTMLSpanElement | null>(null);
  const zoom = useStore((state) => state.transform[2]);

  useEffect(() => {
    const host = sensorRef.current?.closest(".erd-flow");
    if (!host) return;
    host.classList.toggle("is-far-zoom", zoom < EDGE_LABEL_MIN_ZOOM);
  }, [zoom]);

  return <span ref={sensorRef} className="erd-zoom-sensor" aria-hidden="true" />;
});
