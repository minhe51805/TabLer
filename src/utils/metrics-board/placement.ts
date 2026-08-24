import type { MetricsBoardDefinition, MetricsWidgetDefinition } from "../../types";
import type { MetricsWidgetSeed } from "./shared";

export function createUniqueBoardName(baseName: string, existingBoards: MetricsBoardDefinition[]) {
  const normalizedBaseName = baseName.trim() || "AI Dashboard";
  const existingNames = new Set(existingBoards.map((board) => board.name.trim().toLowerCase()));
  if (!existingNames.has(normalizedBaseName.toLowerCase())) {
    return normalizedBaseName;
  }

  let suffix = 2;
  while (existingNames.has(`${normalizedBaseName.toLowerCase()} ${suffix}`)) {
    suffix += 1;
  }
  return `${normalizedBaseName} ${suffix}`;
}

export function createWidgetFromSeed(seed: MetricsWidgetSeed): MetricsWidgetDefinition {
  return {
    id: `widget-${crypto.randomUUID()}`,
    type: seed.type,
    title: seed.title,
    query: seed.query,
    refresh_seconds: seed.refreshSeconds ?? 30,
    col_span: seed.colSpan,
    row_span: seed.rowSpan,
    grid_x: seed.gridX,
    grid_y: seed.gridY,
  };
}

export function widgetsOverlap(a: MetricsWidgetDefinition, b: MetricsWidgetDefinition) {
  return !(
    a.grid_x + a.col_span <= b.grid_x ||
    b.grid_x + b.col_span <= a.grid_x ||
    a.grid_y + a.row_span <= b.grid_y ||
    b.grid_y + b.row_span <= a.grid_y
  );
}

export function canPlaceWidget(widgets: MetricsWidgetDefinition[], candidate: MetricsWidgetDefinition) {
  if (candidate.grid_x < 0 || candidate.grid_y < 0) return false;
  if (candidate.grid_x + candidate.col_span > 14) return false;
  return widgets.every((widget) => !widgetsOverlap(widget, candidate));
}

export function findFirstAvailablePosition(
  widgets: MetricsWidgetDefinition[],
  candidate: MetricsWidgetDefinition,
) {
  for (let gridY = 0; gridY < 128; gridY += 1) {
    for (let gridX = 0; gridX <= 14 - candidate.col_span; gridX += 1) {
      const nextCandidate = {
        ...candidate,
        grid_x: gridX,
        grid_y: gridY,
      };
      if (canPlaceWidget(widgets, nextCandidate)) {
        return nextCandidate;
      }
    }
  }

  return candidate;
}
