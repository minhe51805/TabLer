/**
 * Fullscreen AI image viewer (Claude-style): dark backdrop, download/close
 * toolbar, zoom controls at the bottom. Portaled to document.body so the
 * sidebar overlay's `pointer-events: none` cannot swallow the clicks.
 */
import { Download, Minus, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export interface AIImageViewerLabels {
  close: string;
  download: string;
  resetZoom: string;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

export function AIImageViewer({
  image,
  labels,
  onClose,
}: {
  image: { url: string; name: string } | null;
  labels: AIImageViewerLabels;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    setZoom(1);
  }, [image?.url]);

  useEffect(() => {
    if (!image) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "+" || event.key === "=") setZoom((current) => clampZoom(current + 0.25));
      else if (event.key === "-") setZoom((current) => clampZoom(current - 0.25));
      else if (event.key === "0") setZoom(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [image, onClose]);

  if (!image || typeof document === "undefined") return null;

  const stepZoom = (delta: number) => setZoom((current) => clampZoom(current + delta));

  return createPortal(
    <div
      className="ai-image-viewer-overlay"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      onWheel={(event) => {
        if (event.deltaY !== 0) {
          event.preventDefault();
          stepZoom(event.deltaY < 0 ? 0.15 : -0.15);
        }
      }}
    >
      <div className="ai-image-viewer-toolbar" onClick={(event) => event.stopPropagation()}>
        <a
          className="ai-image-viewer-btn"
          href={image.url}
          download={image.name || "image"}
          title={labels.download}
          aria-label={labels.download}
        >
          <Download className="w-4 h-4" />
        </a>
        <button
          type="button"
          className="ai-image-viewer-btn"
          onClick={onClose}
          title={labels.close}
          aria-label={labels.close}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="ai-image-viewer-stage">
        <img
          className="ai-image-viewer-img"
          src={image.url}
          alt={image.name}
          draggable={false}
          onClick={(event) => event.stopPropagation()}
          style={{ transform: `scale(${zoom})` }}
        />
      </div>
      <div className="ai-image-viewer-zoombar" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="ai-image-viewer-btn ai-image-viewer-btn--small"
          onClick={() => stepZoom(-0.25)}
          aria-label="-"
        >
          <Minus className="w-4 h-4" />
        </button>
        <button
          type="button"
          className="ai-image-viewer-zoom-label"
          onClick={() => setZoom(1)}
          title={labels.resetZoom}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="ai-image-viewer-btn ai-image-viewer-btn--small"
          onClick={() => stepZoom(0.25)}
          aria-label="+"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
