/**
 * Board persistence plus board/widget factory functions.
 */

import type {
  MetricsBoardDefinition,
  MetricsWidgetDefinition,
  MetricsWidgetType,
} from "../../../types";
import {
  canPlaceWidget,
  clampGridX,
  clampGridY,
  findFirstAvailablePosition,
  METRICS_DEFAULT_COL_SPAN,
  METRICS_DEFAULT_ROW_SPAN,
  sanitizeWidgetLayouts,
  type GridPosition,
} from "./metrics-grid-config";
import { getWidgetLibraryItem, WIDGET_LIBRARY } from "./metrics-widget-catalog";

// Storage
// ---------------------------------------------------------------------------

// Re-export METRICS_STORAGE_KEY so both MetricsBoard and query-builder reference the same value.
export const METRICS_STORAGE_KEY = "tabler.metricsBoards.v1";

function migrateLegacyAIMetricsWidgetQuery(widget: MetricsWidgetDefinition) {
  const normalizedTitle = widget.title.trim().toLowerCase();
  let nextQuery = widget.query;

  if (normalizedTitle === "top users by orders") {
    nextQuery = nextQuery.replace(
      /u\."id"\s*=\s*o\."user_id"/gi,
      'u."id"::text = o."user_id"::text',
    );
  }

  if (normalizedTitle === "top products by ordered qty") {
    nextQuery = nextQuery.replace(
      /p\."id"\s*=\s*oi\."product_id"/gi,
      'p."id"::text = oi."product_id"::text',
    );
  }

  if (normalizedTitle === "products by category") {
    nextQuery = nextQuery.replace(
      /c\."id"\s*=\s*p\."category_id"/gi,
      'c."id"::text = p."category_id"::text',
    );
  }

  if (normalizedTitle === "products by brand") {
    nextQuery = nextQuery.replace(
      /b\."id"\s*=\s*p\."brand_id"/gi,
      'b."id"::text = p."brand_id"::text',
    );
  }

  if (normalizedTitle === "average rating by product" || normalizedTitle === "reviews by product") {
    nextQuery = nextQuery.replace(
      /FROM\s+([^\s]+)\s+r\s+LEFT\s+JOIN\s+([^\s]+)\s+p\s+ON\s+p\."id"(?:::\w+)?\s*=\s*r\."product_id"(?:::\w+)?/gi,
      'FROM $2 p\nLEFT JOIN $1 r ON p."id"::text = r."product_id"::text',
    );
    nextQuery = nextQuery.replace(
      /p\."id"\s*=\s*r\."product_id"/gi,
      'p."id"::text = r."product_id"::text',
    );
    nextQuery = nextQuery.replace(
      /COUNT\(\*\)::bigint AS value/gi,
      'COUNT(r."product_id")::bigint AS value',
    );
    if (!/WHERE\s+p\."id"\s+IS\s+NOT\s+NULL/mi.test(nextQuery)) {
      nextQuery = nextQuery.replace(
        /\nGROUP BY 1/mi,
        '\nWHERE p."id" IS NOT NULL\nGROUP BY 1',
      );
    }
  }

  return nextQuery === widget.query
    ? widget
    : {
        ...widget,
        query: nextQuery,
      };
}

export function readStoredBoards(): MetricsBoardDefinition[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(METRICS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    let migrated = false;

    const boards = parsed
      .map((board): MetricsBoardDefinition | null => {
        if (!board || typeof board !== "object") return null;
        if (typeof board.id !== "string" || typeof board.name !== "string" || typeof board.connection_id !== "string") {
          return null;
        }

        const widgets = Array.isArray(board.widgets)
          ? board.widgets
              .map((widget: unknown): MetricsWidgetDefinition | null => {
                if (!widget || typeof widget !== "object") return null;
                const widgetRecord = widget as Record<string, unknown>;
                if (
                  typeof widgetRecord.id !== "string" ||
                  typeof widgetRecord.type !== "string" ||
                  typeof widgetRecord.title !== "string" ||
                  typeof widgetRecord.query !== "string"
                ) {
                  return null;
                }

                if (!WIDGET_LIBRARY.some((item) => item.type === widgetRecord.type)) return null;

                return {
                  id: widgetRecord.id,
                  type: widgetRecord.type as MetricsWidgetType,
                  title: widgetRecord.title,
                  query: widgetRecord.query,
                  refresh_seconds:
                    typeof widgetRecord.refresh_seconds === "number" && widgetRecord.refresh_seconds >= 0
                      ? widgetRecord.refresh_seconds
                      : 15,
                  col_span:
                    typeof widgetRecord.col_span === "number" && widgetRecord.col_span >= 3
                      ? widgetRecord.col_span
                      : METRICS_DEFAULT_COL_SPAN,
                  row_span:
                    typeof widgetRecord.row_span === "number" && widgetRecord.row_span >= 2
                      ? widgetRecord.row_span
                      : METRICS_DEFAULT_ROW_SPAN,
                  grid_x:
                    typeof widgetRecord.grid_x === "number" && widgetRecord.grid_x >= 0
                      ? widgetRecord.grid_x
                      : 0,
                  grid_y:
                    typeof widgetRecord.grid_y === "number" && widgetRecord.grid_y >= 0
                      ? widgetRecord.grid_y
                      : 0,
                };
              })
              .filter((widget: MetricsWidgetDefinition | null): widget is MetricsWidgetDefinition => !!widget)
          : [];

        const migratedWidgets = widgets.map((widget: MetricsWidgetDefinition) => {
          const nextWidget = migrateLegacyAIMetricsWidgetQuery(widget);
          if (nextWidget.query !== widget.query) {
            migrated = true;
          }
          return nextWidget;
        });

        return {
          id: board.id,
          name: board.name,
          connection_id: board.connection_id,
          database: typeof board.database === "string" ? board.database : undefined,
          widgets: sanitizeWidgetLayouts(migratedWidgets),
          created_at: typeof board.created_at === "number" ? board.created_at : Date.now(),
          updated_at:
            migrated || typeof board.updated_at !== "number"
              ? Date.now()
              : board.updated_at,
        };
      })
      .filter((board): board is MetricsBoardDefinition => !!board);

    if (migrated) {
      window.localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify(boards));
    }

    return boards;
  } catch {
    return [];
  }
}

export function writeStoredBoards(boards: MetricsBoardDefinition[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify(boards));
}

// ---------------------------------------------------------------------------
// Board / widget factory
// ---------------------------------------------------------------------------

function nextUntitledBoardName(existingBoards: MetricsBoardDefinition[]) {
  const base = "untitled metrics";
  const normalizedNames = new Set(existingBoards.map((board) => board.name.trim().toLowerCase()));
  if (!normalizedNames.has(base)) return base;

  let index = 1;
  while (normalizedNames.has(`${base} ${index}`)) {
    index += 1;
  }

  return `${base} ${index}`;
}

export function createBoardDefinition(
  connectionId: string,
  database: string | undefined,
  existingBoards: MetricsBoardDefinition[],
): MetricsBoardDefinition {
  const now = Date.now();
  return {
    id: `metrics-${crypto.randomUUID()}`,
    name: nextUntitledBoardName(existingBoards),
    connection_id: connectionId,
    database,
    widgets: [],
    created_at: now,
    updated_at: now,
  };
}

export function createWidgetDefinition(
  type: MetricsWidgetType,
  existingWidgets: MetricsWidgetDefinition[],
  preferredPosition?: Partial<GridPosition>,
): MetricsWidgetDefinition {
  const item = getWidgetLibraryItem(type);
  const baseWidget: MetricsWidgetDefinition = {
    id: `widget-${crypto.randomUUID()}`,
    type,
    title: item.defaultTitle,
    query: item.defaultQuery,
    refresh_seconds: 15,
    col_span: item.colSpan,
    row_span: item.rowSpan,
    grid_x: clampGridX(preferredPosition?.grid_x, item.colSpan),
    grid_y: clampGridY(preferredPosition?.grid_y),
  };
  const nextPosition = canPlaceWidget(existingWidgets, baseWidget)
    ? { grid_x: baseWidget.grid_x, grid_y: baseWidget.grid_y }
    : findFirstAvailablePosition(existingWidgets, baseWidget);
  return {
    ...baseWidget,
    ...nextPosition,
  };
}

// ---------------------------------------------------------------------------
