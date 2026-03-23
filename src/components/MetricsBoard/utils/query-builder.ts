import { invoke } from "@tauri-apps/api/core";
import {
  BarChart3,
  Hash,
  LineChart,
  PieChart,
  Table2,
} from "lucide-react";
import { translateCurrent, type TranslationKey } from "../../../i18n";
import type {
  MetricsBoardDefinition,
  MetricsWidgetDefinition,
  MetricsWidgetType,
  QueryResult,
} from "../../../types";
import { splitSqlStatements } from "../../../utils/sqlStatements";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const METRICS_QUERY_TIMEOUT_MS = 30_000;
export const METRICS_GRID_COLUMNS = 12;
export const METRICS_GRID_GAP = 12;
export const METRICS_GRID_ROW_HEIGHT = 82;
export const METRICS_GRID_MIN_ROWS = 8;
export const METRICS_GRID_MIN_WIDTH = 1080;
export const METRICS_DEFAULT_COL_SPAN = 4;
export const METRICS_DEFAULT_ROW_SPAN = 4;
export const METRICS_MIN_COL_SPAN = 3;
export const METRICS_MAX_COL_SPAN = 6;
export const METRICS_MIN_ROW_SPAN = 2;
export const METRICS_MAX_ROW_SPAN = 6;
export const METRICS_EDITOR_MAX_WIDTH = 320;
export const METRICS_EDITOR_MIN_WIDTH = 272;
export const METRICS_EDITOR_ESTIMATED_HEIGHT = 372;
export const METRICS_EDITOR_GAP = 18;
export const METRICS_DRAG_HOLD_MS = 180;
const REFRESH_OPTIONS = [0, 5, 15, 30, 60, 300] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GridPosition = {
  grid_x: number;
  grid_y: number;
};

export type MetricsSelectOption<T extends string | number> = {
  value: T;
  label: string;
};

export type WidgetLibraryItem = {
  type: MetricsWidgetType;
  label: string;
  description: string;
  icon: typeof Table2;
  defaultTitle: string;
  defaultQuery: string;
  colSpan: number;
  rowSpan: number;
};

type WidgetLibraryBlueprint = Omit<WidgetLibraryItem, "label" | "defaultTitle"> & {
  labelKey: TranslationKey;
  titleKey: TranslationKey;
};

// ---------------------------------------------------------------------------
// Widget library
// ---------------------------------------------------------------------------

const WIDGET_LIBRARY: WidgetLibraryBlueprint[] = [
  {
    type: "table",
    labelKey: "metrics.widget.table",
    description: "Preview rows from a read-only query.",
    icon: Table2,
    titleKey: "metrics.widget.untitledTable",
    defaultQuery: "SELECT 1 AS value, 'sample' AS label",
    colSpan: 6,
    rowSpan: 4,
  },
  {
    type: "scoreboard",
    labelKey: "metrics.widget.scoreboard",
    description: "Show a single KPI from the first row.",
    icon: Hash,
    titleKey: "metrics.widget.untitledMetric",
    defaultQuery: "SELECT 42 AS total, 'items' AS label",
    colSpan: 3,
    rowSpan: 3,
  },
  {
    type: "bar",
    labelKey: "metrics.widget.bar",
    description: "Plot category totals from two columns.",
    icon: BarChart3,
    titleKey: "metrics.widget.untitledBar",
    defaultQuery:
      "SELECT 'A' AS label, 12 AS value UNION ALL SELECT 'B', 19 UNION ALL SELECT 'C', 7",
    colSpan: 4,
    rowSpan: 4,
  },
  {
    type: "line",
    labelKey: "metrics.widget.line",
    description: "Track value trends from two columns.",
    icon: LineChart,
    titleKey: "metrics.widget.untitledLine",
    defaultQuery:
      "SELECT 'Jan' AS label, 11 AS value UNION ALL SELECT 'Feb', 18 UNION ALL SELECT 'Mar', 15 UNION ALL SELECT 'Apr', 23",
    colSpan: 4,
    rowSpan: 4,
  },
  {
    type: "pie",
    labelKey: "metrics.widget.pie",
    description: "Break totals into slices from two columns.",
    icon: PieChart,
    titleKey: "metrics.widget.untitledPie",
    defaultQuery:
      "SELECT 'Done' AS label, 72 AS value UNION ALL SELECT 'Pending', 18 UNION ALL SELECT 'Blocked', 10",
    colSpan: 4,
    rowSpan: 4,
  },
];

export function getWidgetLibrary(): WidgetLibraryItem[] {
  return WIDGET_LIBRARY.map((item) => ({
    ...item,
    label: translateCurrent(item.labelKey),
    defaultTitle: translateCurrent(item.titleKey),
  }));
}

export function getWidgetLibraryItem(type: MetricsWidgetType) {
  const library = getWidgetLibrary();
  return library.find((item) => item.type === type) || library[0];
}

// ---------------------------------------------------------------------------
// Select options
// ---------------------------------------------------------------------------

export function getMetricsRefreshSelectOptions(): readonly MetricsSelectOption<(typeof REFRESH_OPTIONS)[number]>[] {
  return REFRESH_OPTIONS.map((option) => ({
    value: option,
    label:
      option === 0
        ? translateCurrent("metrics.manual")
        : translateCurrent("metrics.everySeconds", { seconds: option }),
  }));
}

export function getMetricsSizeSelectOptions(): readonly MetricsSelectOption<string>[] {
  return [
    { value: "3x3", label: translateCurrent("metrics.size.small") },
    { value: "4x4", label: translateCurrent("metrics.size.medium") },
    { value: "6x4", label: translateCurrent("metrics.size.wide") },
    { value: "6x5", label: translateCurrent("metrics.size.large") },
  ];
}

// ---------------------------------------------------------------------------
// String utilities
// ---------------------------------------------------------------------------

export function getLastPathSegment(value?: string | null) {
  if (!value) return "";
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
}

export function compactMetricsLabel(value?: string | null, maxLength = 18) {
  if (!value) return "";
  if (value.length <= maxLength) return value;
  const tailLength = Math.max(4, Math.floor(maxLength * 0.35));
  const headLength = Math.max(6, maxLength - tailLength - 1);
  return `${value.slice(0, headLength)}…${value.slice(-tailLength)}`;
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

export function formatExecutionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error:\s*/, "");
}

// ---------------------------------------------------------------------------
// Timeout wrapper
// ---------------------------------------------------------------------------

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

function stripLeadingSqlNoise(statement: string) {
  let remaining = statement;

  while (true) {
    remaining = remaining.trimStart();
    if (remaining.startsWith("--")) {
      const nextLineIndex = remaining.indexOf("\n");
      if (nextLineIndex === -1) return "";
      remaining = remaining.slice(nextLineIndex + 1);
      continue;
    }

    if (remaining.startsWith("/*")) {
      const commentEnd = remaining.indexOf("*/");
      if (commentEnd === -1) return "";
      remaining = remaining.slice(commentEnd + 2);
      continue;
    }

    return remaining;
  }
}

function normalizeSqlForMetrics(statement: string) {
  return stripLeadingSqlNoise(statement).replace(/\s+/g, " ").trim().toUpperCase();
}

export function validateMetricsQuery(sql: string): { ok: true; statement: string } | { ok: false; error: string } {
  const statements = splitSqlStatements(sql)
    .map((statement) => statement.trim())
    .filter(Boolean);

  if (statements.length === 0) {
    return { ok: false, error: translateCurrent("metrics.validation.addQuery") };
  }

  if (statements.length > 1) {
    return { ok: false, error: translateCurrent("metrics.validation.singleStatement") };
  }

  const statement = statements[0];
  const normalized = normalizeSqlForMetrics(statement);
  if (!normalized) {
    return { ok: false, error: translateCurrent("metrics.validation.singleStatement") };
  }

  const readPrefixes = ["SELECT", "WITH", "SHOW", "DESCRIBE", "EXPLAIN", "PRAGMA"];
  const allowed = readPrefixes.some((prefix) => normalized.startsWith(prefix));
  if (!allowed) {
    return {
      ok: false,
      error: translateCurrent("metrics.validation.readOnlyOnly"),
    };
  }

  if (
    normalized.startsWith("WITH") &&
    [" INSERT ", " UPDATE ", " DELETE ", " MERGE "].some((keyword) => normalized.includes(keyword))
  ) {
    return {
      ok: false,
      error: translateCurrent("metrics.validation.noMutatingCte"),
    };
  }

  return { ok: true, statement };
}

// ---------------------------------------------------------------------------
// Number conversion
// ---------------------------------------------------------------------------

export function toNumber(value: string | number | boolean | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Metric data extraction
// ---------------------------------------------------------------------------

export function getMetricValue(result: QueryResult | null) {
  if (!result || result.rows.length === 0 || result.columns.length === 0) {
    return { primary: translateCurrent("metrics.widget.noData"), secondary: "" };
  }

  const row = result.rows[0];
  const numericIndex = row.findIndex((value) => toNumber(value) !== null);
  const primaryValue = numericIndex >= 0 ? row[numericIndex] : row[0];
  const secondaryIndex = row.findIndex((_, index) => index !== numericIndex && row[index] !== null);
  const secondaryValue =
    secondaryIndex >= 0
      ? `${result.columns[secondaryIndex]?.name || "detail"}: ${String(row[secondaryIndex])}`
      : result.columns[numericIndex >= 0 ? numericIndex : 0]?.name || "";

  return {
    primary: primaryValue === null ? "NULL" : String(primaryValue),
    secondary: secondaryValue,
  };
}

export function getSeries(result: QueryResult | null) {
  if (!result || result.rows.length === 0 || result.columns.length === 0) return [];

  return result.rows
    .map((row) => {
      const numericIndex = row.findIndex((value) => toNumber(value) !== null);
      if (numericIndex === -1) return null;

      const labelIndex = numericIndex === 0 ? 1 : 0;
      const numericValue = toNumber(row[numericIndex]);
      if (numericValue === null) return null;

      return {
        label:
          row[labelIndex] === undefined || row[labelIndex] === null
            ? result.columns[numericIndex]?.name || `Value ${numericIndex + 1}`
            : String(row[labelIndex]),
        value: numericValue,
      };
    })
    .filter((item): item is { label: string; value: number } => !!item)
    .slice(0, 8);
}

// ---------------------------------------------------------------------------
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
// Storage
// ---------------------------------------------------------------------------

// Re-export METRICS_STORAGE_KEY so both MetricsBoard and query-builder reference the same value.
export const METRICS_STORAGE_KEY = "tabler.metricsBoards.v1";

export function readStoredBoards(): MetricsBoardDefinition[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(METRICS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
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

        return {
          id: board.id,
          name: board.name,
          connection_id: board.connection_id,
          database: typeof board.database === "string" ? board.database : undefined,
          widgets: sanitizeWidgetLayouts(widgets),
          created_at: typeof board.created_at === "number" ? board.created_at : Date.now(),
          updated_at: typeof board.updated_at === "number" ? board.updated_at : Date.now(),
        };
      })
      .filter((board): board is MetricsBoardDefinition => !!board);
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
// Query execution
// ---------------------------------------------------------------------------

export async function executeMetricsQuery(connectionId: string, statement: string): Promise<QueryResult> {
  return withTimeout<QueryResult>(
    invoke("execute_sandboxed_query", {
      connectionId,
      statements: [statement],
    }),
    METRICS_QUERY_TIMEOUT_MS,
    "Metrics query",
  );
}
