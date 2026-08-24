/**
 * Grid geometry constants/types, clamping and placement helpers.
 */

import type { MetricsWidgetDefinition } from "../../../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const METRICS_QUERY_TIMEOUT_MS = 30_000;
export const METRICS_GRID_COLUMNS = 14;
export const METRICS_GRID_GAP = 8;
export const METRICS_GRID_ROW_HEIGHT = 56;
export const METRICS_GRID_MIN_ROWS = 5;
export const METRICS_GRID_MIN_WIDTH = 900;
export const METRICS_DEFAULT_COL_SPAN = 4;
export const METRICS_DEFAULT_ROW_SPAN = 4;
export const METRICS_MIN_COL_SPAN = 3;
export const METRICS_MAX_COL_SPAN = 6;
export const METRICS_MIN_ROW_SPAN = 2;
export const METRICS_MAX_ROW_SPAN = 6;
export const METRICS_EDITOR_MAX_WIDTH = 280;
export const METRICS_EDITOR_MIN_WIDTH = 228;
export const METRICS_EDITOR_ESTIMATED_HEIGHT = 300;
export const METRICS_EDITOR_GAP = 12;
export const METRICS_DRAG_HOLD_MS = 180;
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GridPosition = {
  grid_x: number;
  grid_y: number;
};

// Grid layout helpers
// ---------------------------------------------------------------------------

export function clampColSpan(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return METRICS_DEFAULT_COL_SPAN;
  return Math.min(METRICS_MAX_COL_SPAN, Math.max(METRICS_MIN_COL_SPAN, Math.round(value)));
}

export function clampRowSpan(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return METRICS_DEFAULT_ROW_SPAN;
  return Math.min(METRICS_MAX_ROW_SPAN, Math.max(METRICS_MIN_ROW_SPAN, Math.round(value)));
}

export function clampGridY(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

export function clampGridX(value: number | undefined, colSpan: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(METRICS_GRID_COLUMNS - colSpan, Math.max(0, Math.round(value)));
}

export function colSpanToWidthPx(colSpan: number, columnWidth: number) {
  return colSpan * columnWidth + Math.max(colSpan - 1, 0) * METRICS_GRID_GAP;
}

export function rowSpanToHeightPx(rowSpan: number) {
  return rowSpan * METRICS_GRID_ROW_HEIGHT + Math.max(rowSpan - 1, 0) * METRICS_GRID_GAP;
}

export function widthPxToColSpan(widthPx: number, columnWidth: number) {
  return clampColSpan((widthPx + METRICS_GRID_GAP) / (columnWidth + METRICS_GRID_GAP));
}

export function heightPxToRowSpan(heightPx: number) {
  return clampRowSpan((heightPx + METRICS_GRID_GAP) / (METRICS_GRID_ROW_HEIGHT + METRICS_GRID_GAP));
}

export function normalizeWidgetLayout(widget: MetricsWidgetDefinition): MetricsWidgetDefinition {
  const colSpan = clampColSpan(widget.col_span);
  const rowSpan = clampRowSpan(widget.row_span);
  return {
    ...widget,
    col_span: colSpan,
    row_span: rowSpan,
    grid_x: clampGridX(widget.grid_x, colSpan),
    grid_y: clampGridY(widget.grid_y),
  };
}

function widgetsOverlap(a: MetricsWidgetDefinition, b: MetricsWidgetDefinition) {
  return !(
    a.grid_x + a.col_span <= b.grid_x ||
    b.grid_x + b.col_span <= a.grid_x ||
    a.grid_y + a.row_span <= b.grid_y ||
    b.grid_y + b.row_span <= a.grid_y
  );
}

export function canPlaceWidget(
  widgets: MetricsWidgetDefinition[],
  candidate: MetricsWidgetDefinition,
  excludeWidgetId?: string,
) {
  if (candidate.grid_x < 0 || candidate.grid_y < 0) return false;
  if (candidate.grid_x + candidate.col_span > METRICS_GRID_COLUMNS) return false;

  return widgets.every((widget) => {
    if (widget.id === excludeWidgetId) return true;
    return !widgetsOverlap(widget, candidate);
  });
}

export function findFirstAvailablePosition(
  widgets: MetricsWidgetDefinition[],
  candidate: MetricsWidgetDefinition,
): GridPosition {
  const normalizedCandidate = normalizeWidgetLayout(candidate);

  for (let gridY = 0; gridY < 64; gridY += 1) {
    for (let gridX = 0; gridX <= METRICS_GRID_COLUMNS - normalizedCandidate.col_span; gridX += 1) {
      const proposed = {
        ...normalizedCandidate,
        grid_x: gridX,
        grid_y: gridY,
      };
      if (canPlaceWidget(widgets, proposed, normalizedCandidate.id)) {
        return { grid_x: gridX, grid_y: gridY };
      }
    }
  }

  return { grid_x: 0, grid_y: 0 };
}

export function sanitizeWidgetLayouts(widgets: MetricsWidgetDefinition[]) {
  const placed: MetricsWidgetDefinition[] = [];

  return widgets.map((widget) => {
    const normalized = normalizeWidgetLayout(widget);
    const preferred =
      typeof widget.grid_x === "number" && typeof widget.grid_y === "number"
        ? normalized
        : { ...normalized, ...findFirstAvailablePosition(placed, normalized) };

    const resolved = canPlaceWidget(placed, preferred, preferred.id)
      ? preferred
      : { ...normalized, ...findFirstAvailablePosition(placed, normalized) };

    placed.push(resolved);
    return resolved;
  });
}

// ---------------------------------------------------------------------------
