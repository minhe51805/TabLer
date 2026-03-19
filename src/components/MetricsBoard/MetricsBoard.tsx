import Editor, { type OnMount } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  Database,
  Hash,
  LineChart,
  PieChart,
  Plus,
  RefreshCcw,
  Search,
  Table2,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useAppStore } from "../../stores/appStore";
import { translateCurrent, useI18n, type TranslationKey } from "../../i18n";
import type {
  MetricsBoardDefinition,
  MetricsWidgetDefinition,
  MetricsWidgetType,
  QueryResult,
} from "../../types";
import { splitSqlStatements } from "../../utils/sqlStatements";

export const METRICS_STORAGE_KEY = "tabler.metricsBoards.v1";
const METRICS_QUERY_TIMEOUT_MS = 30_000;
const REFRESH_OPTIONS = [0, 5, 15, 30, 60, 300] as const;
const METRICS_GRID_COLUMNS = 12;
const METRICS_GRID_GAP = 12;
const METRICS_GRID_ROW_HEIGHT = 82;
const METRICS_GRID_MIN_ROWS = 8;
const METRICS_GRID_MIN_WIDTH = 1080;
const METRICS_DEFAULT_COL_SPAN = 4;
const METRICS_DEFAULT_ROW_SPAN = 4;
const METRICS_MIN_COL_SPAN = 3;
const METRICS_MAX_COL_SPAN = 6;
const METRICS_MIN_ROW_SPAN = 2;
const METRICS_MAX_ROW_SPAN = 6;
const METRICS_EDITOR_MAX_WIDTH = 320;
const METRICS_EDITOR_MIN_WIDTH = 272;
const METRICS_EDITOR_ESTIMATED_HEIGHT = 372;
const METRICS_EDITOR_GAP = 18;
const METRICS_DRAG_HOLD_MS = 180;

type GridPosition = {
  grid_x: number;
  grid_y: number;
};

type DragState = {
  widgetId: string;
  startClientX: number;
  startClientY: number;
  originGridX: number;
  originGridY: number;
  previewGridX: number;
  previewGridY: number;
};

type ResizeState = {
  widgetId: string;
  startClientX: number;
  startClientY: number;
  originColSpan: number;
  originRowSpan: number;
  previewColSpan: number;
  previewRowSpan: number;
  originWidthPx: number;
  originHeightPx: number;
  previewWidthPx: number;
  previewHeightPx: number;
};

type CanvasContextMenuState = {
  left: number;
  top: number;
  grid_x: number;
  grid_y: number;
  submenuOpen: boolean;
};

type WidgetLibraryItem = {
  type: MetricsWidgetType;
  label: string;
  description: string;
  icon: typeof Table2;
  defaultTitle: string;
  defaultQuery: string;
  colSpan: number;
  rowSpan: number;
};

type MetricsSelectOption<T extends string | number> = {
  value: T;
  label: string;
};

type WidgetLibraryBlueprint = Omit<WidgetLibraryItem, "label" | "defaultTitle"> & {
  labelKey: TranslationKey;
  titleKey: TranslationKey;
};

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

function getMetricsRefreshSelectOptions(): readonly MetricsSelectOption<(typeof REFRESH_OPTIONS)[number]>[] {
  return REFRESH_OPTIONS.map((option) => ({
    value: option,
    label:
      option === 0
        ? translateCurrent("metrics.manual")
        : translateCurrent("metrics.everySeconds", { seconds: option }),
  }));
}

function getMetricsSizeSelectOptions(): readonly MetricsSelectOption<string>[] {
  return [
    { value: "3x3", label: translateCurrent("metrics.size.small") },
    { value: "4x4", label: translateCurrent("metrics.size.medium") },
    { value: "6x4", label: translateCurrent("metrics.size.wide") },
    { value: "6x5", label: translateCurrent("metrics.size.large") },
  ];
}

function getWidgetLibrary(): WidgetLibraryItem[] {
  return WIDGET_LIBRARY.map((item) => ({
    ...item,
    label: translateCurrent(item.labelKey),
    defaultTitle: translateCurrent(item.titleKey),
  }));
}

interface Props {
  connectionId: string;
  database?: string;
  tabId?: string;
  boardId?: string;
  integratedSidebar?: boolean;
}

interface WidgetRunState {
  result: QueryResult | null;
  loading: boolean;
  error: string | null;
  lastRunAt: number | null;
}

function getLastPathSegment(value?: string | null) {
  if (!value) return "";
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
}

function compactMetricsLabel(value?: string | null, maxLength = 18) {
  if (!value) return "";
  if (value.length <= maxLength) return value;
  const tailLength = Math.max(4, Math.floor(maxLength * 0.35));
  const headLength = Math.max(6, maxLength - tailLength - 1);
  return `${value.slice(0, headLength)}…${value.slice(-tailLength)}`;
}

function formatExecutionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error:\s*/, "");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

function validateMetricsQuery(sql: string): { ok: true; statement: string } | { ok: false; error: string } {
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

function toNumber(value: string | number | boolean | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getMetricValue(result: QueryResult | null) {
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

function getSeries(result: QueryResult | null) {
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

function getWidgetLibraryItem(type: MetricsWidgetType) {
  const library = getWidgetLibrary();
  return library.find((item) => item.type === type) || library[0];
}

function clampColSpan(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return METRICS_DEFAULT_COL_SPAN;
  return Math.min(METRICS_MAX_COL_SPAN, Math.max(METRICS_MIN_COL_SPAN, Math.round(value)));
}

function clampRowSpan(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return METRICS_DEFAULT_ROW_SPAN;
  return Math.min(METRICS_MAX_ROW_SPAN, Math.max(METRICS_MIN_ROW_SPAN, Math.round(value)));
}

function clampGridY(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function clampGridX(value: number | undefined, colSpan: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(METRICS_GRID_COLUMNS - colSpan, Math.max(0, Math.round(value)));
}

function colSpanToWidthPx(colSpan: number, columnWidth: number) {
  return colSpan * columnWidth + Math.max(colSpan - 1, 0) * METRICS_GRID_GAP;
}

function rowSpanToHeightPx(rowSpan: number) {
  return rowSpan * METRICS_GRID_ROW_HEIGHT + Math.max(rowSpan - 1, 0) * METRICS_GRID_GAP;
}

function widthPxToColSpan(widthPx: number, columnWidth: number) {
  return clampColSpan((widthPx + METRICS_GRID_GAP) / (columnWidth + METRICS_GRID_GAP));
}

function heightPxToRowSpan(heightPx: number) {
  return clampRowSpan((heightPx + METRICS_GRID_GAP) / (METRICS_GRID_ROW_HEIGHT + METRICS_GRID_GAP));
}

function normalizeWidgetLayout(widget: MetricsWidgetDefinition): MetricsWidgetDefinition {
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

function canPlaceWidget(
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

function findFirstAvailablePosition(
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

function sanitizeWidgetLayouts(widgets: MetricsWidgetDefinition[]) {
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

function createWidgetDefinition(
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

function MetricsCompactSelect<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: readonly MetricsSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; width: number } | null>(null);

  useEffect(() => {
    if (!open) return;

    const updateMenuPosition = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;

      const estimatedHeight = Math.min(options.length * 32 + 14, 240);
      const spaceBelow = window.innerHeight - rect.bottom - 10;
      const shouldOpenUpward = spaceBelow < estimatedHeight && rect.top > estimatedHeight + 10;
      const top = shouldOpenUpward
        ? Math.max(8, rect.top - estimatedHeight - 6)
        : Math.min(window.innerHeight - estimatedHeight - 8, rect.bottom + 6);
      const left = Math.min(window.innerWidth - rect.width - 8, Math.max(8, rect.left));

      setMenuPosition({
        left,
        top,
        width: rect.width,
      });
    };

    updateMenuPosition();

    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open, options.length]);

  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  return (
    <div className={`metrics-compact-select ${open ? "open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="metrics-compact-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selectedOption?.label}</span>
        <ChevronDown className="w-3.5 h-3.5" />
      </button>

      {open && menuPosition
        ? createPortal(
            <div
              ref={menuRef}
              className="metrics-compact-select-menu"
              role="listbox"
              aria-label={ariaLabel}
              style={{
                left: `${menuPosition.left}px`,
                top: `${menuPosition.top}px`,
                width: `${menuPosition.width}px`,
              }}
            >
              {options.map((option) => (
                <button
                  key={String(option.value)}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className={`metrics-compact-select-option ${option.value === value ? "selected" : ""}`}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function ChartBars({ series }: { series: { label: string; value: number }[] }) {
  const max = Math.max(...series.map((item) => item.value), 1);

  return (
    <div className="metrics-widget-bars">
      {series.map((item) => (
        <div key={item.label} className="metrics-widget-bars-item">
          <div
            className="metrics-widget-bars-bar"
            style={{ height: `${Math.max((item.value / max) * 100, 8)}%` }}
          />
          <span className="metrics-widget-bars-label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function ChartLine({ series }: { series: { label: string; value: number }[] }) {
  const width = 240;
  const height = 120;
  const max = Math.max(...series.map((item) => item.value), 1);
  const points = series
    .map((item, index) => {
      const x = series.length === 1 ? width / 2 : (index / (series.length - 1)) * (width - 16) + 8;
      const y = height - (item.value / max) * (height - 24) - 12;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="metrics-widget-line-chart" preserveAspectRatio="none">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
      />
      {series.map((item, index) => {
        const x = series.length === 1 ? width / 2 : (index / (series.length - 1)) * (width - 16) + 8;
        const y = height - (item.value / max) * (height - 24) - 12;
        return <circle key={item.label} cx={x} cy={y} r="4" fill="currentColor" />;
      })}
    </svg>
  );
}

function ChartPie({ series }: { series: { label: string; value: number }[] }) {
  const total = Math.max(series.reduce((sum, item) => sum + item.value, 0), 1);
  const colors = ["#7aa2ff", "#7fe0c2", "#ffc56b", "#f08aa2", "#b9a3ff", "#7dc9d8"];
  let angle = 0;
  const gradient = series
    .map((item, index) => {
      const start = angle;
      angle += (item.value / total) * 360;
      return `${colors[index % colors.length]} ${start}deg ${angle}deg`;
    })
    .join(", ");

  return (
    <div className="metrics-widget-pie-shell">
      <div className="metrics-widget-pie" style={{ background: `conic-gradient(${gradient})` }} />
      <div className="metrics-widget-pie-legend">
        {series.map((item, index) => (
          <div key={item.label} className="metrics-widget-pie-legend-item">
            <span
              className="metrics-widget-pie-swatch"
              style={{ backgroundColor: colors[index % colors.length] }}
            />
            <span className="metrics-widget-pie-legend-label">{item.label}</span>
            <span className="metrics-widget-pie-legend-value">{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricsWidgetCard({
  widget,
  connectionId,
  selected,
  onSelect,
  layoutStyle,
  dragging,
  resizing,
  onDragStart,
  onResizeStart,
}: {
  widget: MetricsWidgetDefinition;
  connectionId: string;
  selected: boolean;
  onSelect: () => void;
  layoutStyle: CSSProperties;
  dragging: boolean;
  resizing: boolean;
  onDragStart: (clientX: number, clientY: number) => void;
  onResizeStart: (clientX: number, clientY: number) => void;
}) {
  const { language, t } = useI18n();
  const [state, setState] = useState<WidgetRunState>({
    result: null,
    loading: false,
    error: null,
    lastRunAt: null,
  });
  const requestIdRef = useRef(0);
  const holdTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  const runWidgetQuery = useCallback(async () => {
    const validation = validateMetricsQuery(widget.query);
    if (!validation.ok) {
      setState({
        result: null,
        loading: false,
        error: validation.error,
        lastRunAt: null,
      });
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const result = await withTimeout<QueryResult>(
        invoke("execute_sandboxed_query", {
          connectionId,
          statements: [validation.statement],
        }),
        METRICS_QUERY_TIMEOUT_MS,
        "Metrics query",
      );

      if (requestIdRef.current !== requestId) return;
      setState({
        result,
        loading: false,
        error: null,
        lastRunAt: Date.now(),
      });
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setState({
        result: null,
        loading: false,
        error: formatExecutionError(error),
        lastRunAt: Date.now(),
      });
    }
  }, [connectionId, language, widget.query]);

  useEffect(() => {
    void runWidgetQuery();
  }, [runWidgetQuery]);

  useEffect(() => {
    if (widget.refresh_seconds <= 0) return;

    const timer = window.setInterval(() => {
      void runWidgetQuery();
    }, widget.refresh_seconds * 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [runWidgetQuery, widget.refresh_seconds]);

  const series = useMemo(() => getSeries(state.result), [state.result]);
  const metric = useMemo(() => getMetricValue(state.result), [state.result]);
  const validation = useMemo(() => validateMetricsQuery(widget.query), [language, widget.query]);
  const widgetLibraryItem = getWidgetLibraryItem(widget.type);

  const content = (() => {
    if (state.loading && !state.result) {
      return <div className="metrics-widget-empty">{t("metrics.widget.loading")}</div>;
    }

    if (!validation.ok) {
      return <div className="metrics-widget-empty error">{validation.error}</div>;
    }

    if (state.error) {
      return <div className="metrics-widget-empty error">{state.error}</div>;
    }

    if (!state.result || state.result.rows.length === 0) {
      return <div className="metrics-widget-empty">{t("metrics.widget.noData")}</div>;
    }

    if (widget.type === "scoreboard") {
      return (
        <div className="metrics-widget-score">
          <span className="metrics-widget-score-value">{metric.primary}</span>
          <span className="metrics-widget-score-label">{metric.secondary}</span>
        </div>
      );
    }

    if (widget.type === "table") {
      return (
        <div className="metrics-widget-table-wrap">
          <table className="metrics-widget-table">
            <thead>
              <tr>
                {state.result.columns.slice(0, 4).map((column) => (
                  <th key={column.name}>{column.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.result.rows.slice(0, 5).map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.slice(0, 4).map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell === null ? "NULL" : String(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    if (series.length === 0) {
      return <div className="metrics-widget-empty">{t("metrics.widget.queryNeedsSeries")}</div>;
    }

    if (widget.type === "bar") {
      return <ChartBars series={series} />;
    }

    if (widget.type === "line") {
      return <ChartLine series={series} />;
    }

    return <ChartPie series={series} />;
  })();

  const clearPendingHold = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearPendingHold, [clearPendingHold]);

  const beginCardHoldDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (event.defaultPrevented) return;

      let latestX = event.clientX;
      let latestY = event.clientY;

      clearPendingHold();

      const cancelPendingHold = () => {
        clearPendingHold();
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      const handlePointerMove = (nativeEvent: PointerEvent) => {
        latestX = nativeEvent.clientX;
        latestY = nativeEvent.clientY;
      };

      const handlePointerUp = () => {
        cancelPendingHold();
      };

      holdTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = true;
        cancelPendingHold();
        onDragStart(latestX, latestY);
      }, METRICS_DRAG_HOLD_MS);

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
      window.addEventListener("pointercancel", handlePointerUp, { once: true });
    },
    [clearPendingHold, onDragStart],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      className={`metrics-widget-card ${selected ? "selected" : ""} ${dragging ? "dragging" : ""} ${resizing ? "resizing" : ""}`}
      style={layoutStyle}
      onPointerDown={beginCardHoldDrag}
      onClick={() => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="metrics-widget-card-head">
        <div className="metrics-widget-card-head-main">
          <div className="metrics-widget-card-title-wrap">
            <span className="metrics-widget-card-type">{widgetLibraryItem.label}</span>
            <strong className="metrics-widget-card-title">{widget.title}</strong>
          </div>
        </div>
        <button
          type="button"
          className="metrics-widget-refresh-btn"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            void runWidgetQuery();
          }}
          title={t("metrics.widget.refresh")}
        >
          <RefreshCcw className={`w-3.5 h-3.5 ${state.loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="metrics-widget-card-body">{content}</div>

      <div className="metrics-widget-card-foot">
        <span className={`metrics-widget-status ${state.error ? "error" : ""}`}>
          {state.error
            ? t("metrics.widget.issue")
            : state.loading
              ? t("metrics.widget.refreshing")
              : t("metrics.widget.live")}
        </span>
        <span className="metrics-widget-foot-meta">
          {state.result
            ? `${state.result.execution_time_ms}ms`
            : widget.refresh_seconds > 0
              ? t("metrics.everySeconds", { seconds: widget.refresh_seconds })
              : t("metrics.manual")}
        </span>
      </div>

      <button
        type="button"
        className="metrics-widget-resize-handle"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onResizeStart(event.clientX, event.clientY);
        }}
        onClick={(event) => event.stopPropagation()}
        title={t("common.size")}
      />
    </div>
  );
}

export function MetricsBoard({
  connectionId,
  database,
  tabId,
  boardId,
  integratedSidebar = true,
}: Props) {
  const { t } = useI18n();
  const updateTab = useAppStore((state) => state.updateTab);
  const connections = useAppStore((state) => state.connections);
  const [boards, setBoards] = useState<MetricsBoardDefinition[]>([]);
  const [boardSearch, setBoardSearch] = useState("");
  const [activeBoardId, setActiveBoardId] = useState<string | null>(boardId ?? null);
  const [activeWidgetId, setActiveWidgetId] = useState<string | null>(null);
  const [editingWidgetId, setEditingWidgetId] = useState<string | null>(null);
  const [widgetQueryDraft, setWidgetQueryDraft] = useState("");
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenuState | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(METRICS_GRID_MIN_WIDTH);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const boardSearchInputRef = useRef<HTMLInputElement | null>(null);
  const metricsEditorCompletionRef = useRef<{ dispose: () => void } | null>(null);
  const activeConnection = useMemo(
    () => connections.find((connection) => connection.id === connectionId) || null,
    [connectionId, connections],
  );
  const metricsRefreshOptions = useMemo(() => getMetricsRefreshSelectOptions(), [t]);
  const metricsSizeOptions = useMemo(() => getMetricsSizeSelectOptions(), [t]);

  const persistBoards = useCallback(
    (nextBoards: MetricsBoardDefinition[]) => {
      setBoards(nextBoards);
      const allBoards = readStoredBoards();
      const otherBoards = allBoards.filter((board) => board.connection_id !== connectionId);
      writeStoredBoards([...otherBoards, ...nextBoards]);
      window.dispatchEvent(
        new CustomEvent("metrics-boards-updated", {
          detail: { connectionId },
        }),
      );
    },
    [connectionId],
  );

  useEffect(() => {
    const connectionBoards = readStoredBoards().filter((board) => board.connection_id === connectionId);
    if (connectionBoards.length === 0) {
      const initialBoard = createBoardDefinition(connectionId, database, []);
      persistBoards([initialBoard]);
      setActiveBoardId(initialBoard.id);
      setActiveWidgetId(null);
      setEditingWidgetId(null);
      return;
    }

    setBoards(connectionBoards);
    const nextActiveBoardId =
      (boardId && connectionBoards.some((board) => board.id === boardId) && boardId) ||
      connectionBoards[0].id;
    setActiveBoardId(nextActiveBoardId);
    setActiveWidgetId(null);
    setEditingWidgetId(null);
  }, [boardId, connectionId, database, persistBoards]);

  const filteredBoards = useMemo(() => {
    const query = boardSearch.trim().toLowerCase();
    if (!query) return boards;
    return boards.filter((board) => board.name.toLowerCase().includes(query));
  }, [boardSearch, boards]);

  const activeBoard = useMemo(
    () => boards.find((board) => board.id === activeBoardId) || null,
    [activeBoardId, boards],
  );

  const editingWidget = useMemo(
    () => activeBoard?.widgets.find((widget) => widget.id === editingWidgetId) || null,
    [activeBoard, editingWidgetId],
  );

  const displayDatabaseLabel = useMemo(() => {
    if (!database && !activeBoard?.database) return activeConnection?.name || t("common.database");
    const rawDatabase =
      activeConnection?.db_type === "sqlite"
        ? getLastPathSegment(database || activeBoard?.database)
        : database || activeBoard?.database || "";
    return compactMetricsLabel(rawDatabase || activeConnection?.name || t("common.database"));
  }, [activeBoard?.database, activeConnection?.db_type, activeConnection?.name, database, t]);

  const displayConnectionLabel = useMemo(() => {
    const source =
      activeConnection?.db_type === "sqlite"
        ? `${t("common.file")} workspace`
        : activeConnection?.name || activeConnection?.host || t("workspace.ready.connection");
    return compactMetricsLabel(source, 16);
  }, [activeConnection?.db_type, activeConnection?.host, activeConnection?.name, t]);

  const shouldKeepWidgetSelection = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;

    return Boolean(
      target.closest(".metrics-widget-card") ||
        target.closest(".metrics-widget-editor") ||
        target.closest(".metrics-board-list-child") ||
        target.closest(".metrics-board-context-menu-shell"),
    );
  }, []);

  const clearWidgetSelection = useCallback(() => {
    setActiveWidgetId(null);
    setEditingWidgetId(null);
  }, []);

  const handleWidgetSelection = useCallback((widgetId: string) => {
    setActiveWidgetId((current) => (current === widgetId ? null : widgetId));
    setEditingWidgetId((current) => (current === widgetId ? null : widgetId));
    setCanvasContextMenu(null);
  }, []);

  const handleShellPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if ((!activeWidgetId && !editingWidgetId) || dragState || resizeState) return;
      if (shouldKeepWidgetSelection(event.target)) return;
      clearWidgetSelection();
    },
    [activeWidgetId, clearWidgetSelection, dragState, editingWidgetId, resizeState, shouldKeepWidgetSelection],
  );

  useEffect(() => {
    if (!activeBoard) return;
    if (activeWidgetId && !activeBoard.widgets.some((widget) => widget.id === activeWidgetId)) {
      setActiveWidgetId(null);
    }
    if (editingWidgetId && !activeBoard.widgets.some((widget) => widget.id === editingWidgetId)) {
      setEditingWidgetId(null);
    }
  }, [activeBoard, activeWidgetId, editingWidgetId]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const updateCanvasWidth = () => {
      setCanvasWidth(Math.max(element.clientWidth - 36, METRICS_GRID_MIN_WIDTH));
    };

    updateCanvasWidth();

    const observer = new ResizeObserver(() => {
      updateCanvasWidth();
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!tabId || !activeBoard) return;
    updateTab(tabId, { metricsBoardId: activeBoard.id, title: activeBoard.name });
  }, [activeBoard, tabId, updateTab]);

  useEffect(() => {
    const handleFocusMetricsWidget = (
      event: Event,
    ) => {
      const detail = (event as CustomEvent<{ boardId?: string; widgetId?: string }>).detail;
      if (!detail?.widgetId) return;

      if (detail.boardId && detail.boardId !== activeBoardId) {
      setActiveBoardId(detail.boardId);
      }

      setActiveWidgetId(detail.widgetId);
      setEditingWidgetId(detail.widgetId);
      setCanvasContextMenu(null);
    };

    window.addEventListener("focus-metrics-widget", handleFocusMetricsWidget);
    return () => window.removeEventListener("focus-metrics-widget", handleFocusMetricsWidget);
  }, [activeBoardId]);

  const surfaceWidth = useMemo(
    () => Math.max(canvasWidth, METRICS_GRID_MIN_WIDTH),
    [canvasWidth],
  );
  const columnWidth = useMemo(
    () => (surfaceWidth - METRICS_GRID_GAP * (METRICS_GRID_COLUMNS - 1)) / METRICS_GRID_COLUMNS,
    [surfaceWidth],
  );
  const rowUnit = METRICS_GRID_ROW_HEIGHT + METRICS_GRID_GAP;
  const colUnit = columnWidth + METRICS_GRID_GAP;
  const surfaceHeight = useMemo(() => {
    const occupiedRows = activeBoard
      ? activeBoard.widgets.reduce((max, widget) => {
          const previewGridY =
            dragState && dragState.widgetId === widget.id ? dragState.previewGridY : widget.grid_y;
          if (resizeState && resizeState.widgetId === widget.id) {
            const bottomPx = previewGridY * rowUnit + resizeState.previewHeightPx;
            const rowCount = Math.ceil((bottomPx + METRICS_GRID_GAP) / rowUnit);
            return Math.max(max, rowCount);
          }
          return Math.max(max, previewGridY + widget.row_span);
        }, METRICS_GRID_MIN_ROWS)
      : METRICS_GRID_MIN_ROWS;
    return occupiedRows * METRICS_GRID_ROW_HEIGHT + Math.max(occupiedRows - 1, 0) * METRICS_GRID_GAP;
  }, [activeBoard, dragState, resizeState]);

  const updateActiveBoard = useCallback(
    (updater: (board: MetricsBoardDefinition) => MetricsBoardDefinition) => {
      if (!activeBoard) return;
      const nextBoards = boards.map((board) =>
        board.id === activeBoard.id
          ? { ...updater(board), updated_at: Date.now() }
          : board,
      );
      persistBoards(nextBoards);
    },
    [activeBoard, boards, persistBoards],
  );

  const updateWidgetLayout = useCallback(
    (widgetId: string, updates: Partial<MetricsWidgetDefinition>) => {
      if (!activeBoard) return;

      updateActiveBoard((board) => {
        const currentWidget = board.widgets.find((widget) => widget.id === widgetId);
        if (!currentWidget) return board;

        const others = board.widgets.filter((widget) => widget.id !== widgetId);
        const candidate = normalizeWidgetLayout({ ...currentWidget, ...updates });
        const positioned = canPlaceWidget(others, candidate, widgetId)
          ? candidate
          : { ...candidate, ...findFirstAvailablePosition(others, candidate) };

        return {
          ...board,
          widgets: board.widgets.map((widget) => (widget.id === widgetId ? positioned : widget)),
        };
      });
    },
    [activeBoard, updateActiveBoard],
  );

  const createBoard = useCallback(() => {
    const nextBoard = createBoardDefinition(connectionId, database, boards);
    const nextBoards = [nextBoard, ...boards];
      persistBoards(nextBoards);
      setActiveBoardId(nextBoard.id);
      setActiveWidgetId(null);
      setEditingWidgetId(null);
  }, [boards, connectionId, database, persistBoards]);

  const handleOpenDatabaseSidebar = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("open-left-sidebar-panel", {
        detail: {
          panel: "database",
          focusSearch: true,
        },
      }),
    );
  }, []);

  const handleFocusMetricsSidebar = useCallback(() => {
    boardSearchInputRef.current?.focus();
    boardSearchInputRef.current?.select();
  }, []);

  const addWidget = useCallback(
    (type: MetricsWidgetType, preferredPosition?: Partial<GridPosition>) => {
      if (!activeBoard) return;
      const nextWidget = createWidgetDefinition(type, activeBoard.widgets, preferredPosition);
      updateActiveBoard((board) => ({
        ...board,
        widgets: [...board.widgets, nextWidget],
      }));
      setActiveWidgetId(nextWidget.id);
      setEditingWidgetId(nextWidget.id);
      setCanvasContextMenu(null);
    },
    [activeBoard, updateActiveBoard],
  );

  const updateSelectedWidget = useCallback(
    (updates: Partial<MetricsWidgetDefinition>) => {
      if (!editingWidget) return;
      if (
        "col_span" in updates ||
        "row_span" in updates ||
        "grid_x" in updates ||
        "grid_y" in updates
      ) {
        updateWidgetLayout(editingWidget.id, updates);
        return;
      }

      updateActiveBoard((board) => ({
        ...board,
        widgets: board.widgets.map((widget) =>
          widget.id === editingWidget.id ? { ...widget, ...updates } : widget,
        ),
      }));
    },
    [editingWidget, updateActiveBoard, updateWidgetLayout],
  );

  const deleteSelectedWidget = useCallback(() => {
    if (!editingWidget) return;
    updateActiveBoard((board) => ({
      ...board,
      widgets: board.widgets.filter((widget) => widget.id !== editingWidget.id),
    }));
    setActiveWidgetId(null);
    setEditingWidgetId(null);
  }, [editingWidget, updateActiveBoard]);

  useEffect(() => {
    setWidgetQueryDraft(editingWidget?.query ?? "");
  }, [editingWidget?.id]);

  useEffect(() => {
    if (!canvasContextMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".metrics-board-context-menu-shell")) return;
      setCanvasContextMenu(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCanvasContextMenu(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [canvasContextMenu]);

  useEffect(() => {
    if (!editingWidget) return;
    if (widgetQueryDraft === editingWidget.query) return;

    const timer = window.setTimeout(() => {
      updateSelectedWidget({ query: widgetQueryDraft });
    }, 160);

    return () => {
      window.clearTimeout(timer);
    };
  }, [editingWidget, updateSelectedWidget, widgetQueryDraft]);

  const getWidgetLayoutMetrics = useCallback(
    (widget: MetricsWidgetDefinition) => {
      const dragPreview =
        dragState && dragState.widgetId === widget.id
          ? { grid_x: dragState.previewGridX, grid_y: dragState.previewGridY }
          : null;
      const gridX = dragPreview?.grid_x ?? widget.grid_x;
      const gridY = dragPreview?.grid_y ?? widget.grid_y;
      const widthPx =
        resizeState && resizeState.widgetId === widget.id
          ? resizeState.previewWidthPx
          : colSpanToWidthPx(widget.col_span, columnWidth);
      const heightPx =
        resizeState && resizeState.widgetId === widget.id
          ? resizeState.previewHeightPx
          : rowSpanToHeightPx(widget.row_span);

      return {
        left: gridX * colUnit,
        top: gridY * rowUnit,
        width: widthPx,
        height: heightPx,
      };
    },
    [colUnit, columnWidth, dragState, resizeState, rowUnit],
  );

  const getWidgetLayoutStyle = useCallback(
    (widget: MetricsWidgetDefinition): CSSProperties => {
      const rect = getWidgetLayoutMetrics(widget);

      return {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      };
    },
    [getWidgetLayoutMetrics],
  );

  const widgetEditorLayout = useMemo(() => {
    if (!editingWidget) return null;

    const rect = getWidgetLayoutMetrics(editingWidget);
    const editorWidth = Math.min(
      METRICS_EDITOR_MAX_WIDTH,
      Math.max(METRICS_EDITOR_MIN_WIDTH, surfaceWidth - 28),
    );
    const rightCandidate = rect.left + rect.width + METRICS_EDITOR_GAP;
    const canPlaceRight = rightCandidate + editorWidth <= surfaceWidth;
    const leftCandidate = rect.left - editorWidth - METRICS_EDITOR_GAP;
    const left = canPlaceRight
      ? rightCandidate
      : Math.max(12, Math.min(leftCandidate, surfaceWidth - editorWidth - 12));
    const top = Math.max(
      12,
      Math.min(rect.top, surfaceHeight - METRICS_EDITOR_ESTIMATED_HEIGHT - 12),
    );

    return {
      left,
      top,
      width: editorWidth,
      height: METRICS_EDITOR_ESTIMATED_HEIGHT,
      side: canPlaceRight ? "right" : "left",
    } as const;
  }, [editingWidget, getWidgetLayoutMetrics, surfaceHeight, surfaceWidth]);

  const openCanvasContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!activeBoard) return;
      if (dragState || resizeState) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(".metrics-widget-card") ||
        target?.closest(".metrics-widget-editor") ||
        target?.closest(".metrics-board-context-menu-shell")
      ) {
        return;
      }

      event.preventDefault();
      const canvasElement = canvasRef.current;
      if (!canvasElement) return;

      const canvasRect = canvasElement.getBoundingClientRect();
      const localX = canvasElement.scrollLeft + event.clientX - canvasRect.left;
      const localY = canvasElement.scrollTop + event.clientY - canvasRect.top;
      const triggerWidth = 96;
      const menuWidth = 176;
      const totalWidth = triggerWidth + 8 + menuWidth;
      const maxLeft = Math.max(16, surfaceWidth - totalWidth - 16);
      const maxTop = Math.max(16, surfaceHeight - 48 - 16);
      const left = Math.max(16, Math.min(localX, maxLeft));
      const top = Math.max(16, Math.min(localY, maxTop));

      clearWidgetSelection();
      setCanvasContextMenu({
        left,
        top,
        grid_x: clampGridX(Math.floor(localX / colUnit), METRICS_DEFAULT_COL_SPAN),
        grid_y: clampGridY(Math.floor(localY / rowUnit)),
        submenuOpen: false,
      });
    },
    [activeBoard, clearWidgetSelection, colUnit, dragState, resizeState, rowUnit, surfaceHeight, surfaceWidth],
  );

  const surfaceContentHeight = useMemo(() => {
    if (!widgetEditorLayout) return surfaceHeight;
    return Math.max(surfaceHeight, widgetEditorLayout.top + widgetEditorLayout.height + 16);
  }, [surfaceHeight, widgetEditorLayout]);

  const handleMetricsEditorMount: OnMount = useCallback((editor, monaco) => {
    metricsEditorCompletionRef.current?.dispose();

    metricsEditorCompletionRef.current = monaco.languages.registerCompletionItemProvider("sql", {
      provideCompletionItems: (model: any, position: any) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        const currentTables = useAppStore.getState().tables;
        const tableSuggestions = currentTables.map((table) => ({
          label: table.name,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: table.name,
          detail: "Table",
          range,
        }));

        const keywords = [
          "SELECT",
          "FROM",
          "WHERE",
          "AND",
          "OR",
          "ORDER BY",
          "GROUP BY",
          "LIMIT",
          "JOIN",
          "LEFT JOIN",
          "INNER JOIN",
          "ON",
          "AS",
          "INSERT INTO",
          "VALUES",
          "UPDATE",
          "SET",
          "DELETE FROM",
          "WITH",
          "SHOW",
          "DESCRIBE",
          "EXPLAIN",
        ];

        const keywordSuggestions = keywords.map((keyword) => ({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          detail: "Keyword",
          range,
        }));

        return {
          suggestions: [...tableSuggestions, ...keywordSuggestions],
        };
      },
    });

    monaco.editor.defineTheme("tabler-metrics-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "keyword", foreground: "7AA2FF", fontStyle: "bold" },
        { token: "string", foreground: "E8BF7A" },
        { token: "number", foreground: "FFB285" },
        { token: "comment", foreground: "65789A", fontStyle: "italic" },
      ],
      colors: {
        "editor.background": "#161d27",
        "editor.foreground": "#e7ecf8",
        "editor.selectionBackground": "#7aa2ff36",
        "editor.lineHighlightBackground": "#22314f66",
        "editorCursor.foreground": "#aec4ff",
        "editorLineNumber.foreground": "#62779d",
        "editorLineNumber.activeForeground": "#e7ecf8",
      },
    });

    editor.updateOptions({ theme: "tabler-metrics-dark" });
  }, []);

  useEffect(() => {
    return () => {
      metricsEditorCompletionRef.current?.dispose();
      metricsEditorCompletionRef.current = null;
    };
  }, []);

  const handleWidgetDragStart = useCallback(
    (widget: MetricsWidgetDefinition, clientX: number, clientY: number) => {
      setActiveWidgetId(widget.id);
      setEditingWidgetId(null);
      setResizeState(null);
      setDragState({
        widgetId: widget.id,
        startClientX: clientX,
        startClientY: clientY,
        originGridX: widget.grid_x,
        originGridY: widget.grid_y,
        previewGridX: widget.grid_x,
        previewGridY: widget.grid_y,
      });
    },
    [],
  );

  const handleWidgetResizeStart = useCallback(
    (widget: MetricsWidgetDefinition, clientX: number, clientY: number) => {
      const originWidthPx = colSpanToWidthPx(widget.col_span, columnWidth);
      const originHeightPx = rowSpanToHeightPx(widget.row_span);
      setActiveWidgetId(widget.id);
      setEditingWidgetId(null);
      setDragState(null);
      setResizeState({
        widgetId: widget.id,
        startClientX: clientX,
        startClientY: clientY,
        originColSpan: widget.col_span,
        originRowSpan: widget.row_span,
        previewColSpan: widget.col_span,
        previewRowSpan: widget.row_span,
        originWidthPx,
        originHeightPx,
        previewWidthPx: originWidthPx,
        previewHeightPx: originHeightPx,
      });
    },
    [columnWidth],
  );

  useEffect(() => {
    if (!dragState || !activeBoard) return;

    const activeWidget = activeBoard.widgets.find((widget) => widget.id === dragState.widgetId);
    if (!activeWidget) return;

    const handlePointerMove = (event: PointerEvent) => {
      const deltaColumns = Math.round((event.clientX - dragState.startClientX) / colUnit);
      const deltaRows = Math.round((event.clientY - dragState.startClientY) / rowUnit);
      const nextGridX = clampGridX(dragState.originGridX + deltaColumns, activeWidget.col_span);
      const nextGridY = clampGridY(dragState.originGridY + deltaRows);

      setDragState((current) => {
        if (!current || current.widgetId !== dragState.widgetId) return current;
        if (current.previewGridX === nextGridX && current.previewGridY === nextGridY) return current;
        return {
          ...current,
          previewGridX: nextGridX,
          previewGridY: nextGridY,
        };
      });
    };

    const finishDrag = () => {
      setDragState((current) => {
        if (!current || current.widgetId !== dragState.widgetId) return null;

        const candidate = normalizeWidgetLayout({
          ...activeWidget,
          grid_x: current.previewGridX,
          grid_y: current.previewGridY,
        });
        const others = activeBoard.widgets.filter((widget) => widget.id !== activeWidget.id);
        if (canPlaceWidget(others, candidate, activeWidget.id)) {
          updateWidgetLayout(activeWidget.id, {
            grid_x: candidate.grid_x,
            grid_y: candidate.grid_y,
          });
        }

        return null;
      });
    };

    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishDrag, { once: true });
    window.addEventListener("pointercancel", finishDrag, { once: true });

    return () => {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
    };
  }, [activeBoard, colUnit, dragState, rowUnit, updateWidgetLayout]);

  useEffect(() => {
    if (!resizeState || !activeBoard) return;

    const activeWidget = activeBoard.widgets.find((widget) => widget.id === resizeState.widgetId);
    if (!activeWidget) return;

    const others = activeBoard.widgets.filter((widget) => widget.id !== activeWidget.id);

    const handlePointerMove = (event: PointerEvent) => {
      const maxColSpan = Math.max(METRICS_MIN_COL_SPAN, METRICS_GRID_COLUMNS - activeWidget.grid_x);
      const minWidthPx = colSpanToWidthPx(METRICS_MIN_COL_SPAN, columnWidth);
      const maxWidthPx = colSpanToWidthPx(maxColSpan, columnWidth);
      const minHeightPx = rowSpanToHeightPx(METRICS_MIN_ROW_SPAN);
      const maxHeightPx = rowSpanToHeightPx(METRICS_MAX_ROW_SPAN);
      const nextWidthPx = Math.min(
        maxWidthPx,
        Math.max(minWidthPx, resizeState.originWidthPx + (event.clientX - resizeState.startClientX)),
      );
      const nextHeightPx = Math.min(
        maxHeightPx,
        Math.max(minHeightPx, resizeState.originHeightPx + (event.clientY - resizeState.startClientY)),
      );
      const nextColSpan = widthPxToColSpan(nextWidthPx, columnWidth);
      const nextRowSpan = heightPxToRowSpan(nextHeightPx);

      setResizeState((current) => {
        if (!current || current.widgetId !== resizeState.widgetId) return current;
        if (
          current.previewColSpan === nextColSpan &&
          current.previewRowSpan === nextRowSpan &&
          current.previewWidthPx === nextWidthPx &&
          current.previewHeightPx === nextHeightPx
        ) {
          return current;
        }
        return {
          ...current,
          previewColSpan: nextColSpan,
          previewRowSpan: nextRowSpan,
          previewWidthPx: nextWidthPx,
          previewHeightPx: nextHeightPx,
        };
      });
    };

    const finishResize = () => {
      setResizeState((current) => {
        if (!current || current.widgetId !== resizeState.widgetId) return null;
        const candidate = normalizeWidgetLayout({
          ...activeWidget,
          col_span: current.previewColSpan,
          row_span: current.previewRowSpan,
        });

        if (canPlaceWidget(others, candidate, activeWidget.id)) {
          updateWidgetLayout(activeWidget.id, {
            col_span: candidate.col_span,
            row_span: candidate.row_span,
          });
        }

        return null;
      });
    };

    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize, { once: true });
    window.addEventListener("pointercancel", finishResize, { once: true });

    return () => {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
  }, [activeBoard, colUnit, resizeState, rowUnit, updateWidgetLayout]);

  return (
    <div
      className={`metrics-board-shell ${integratedSidebar ? "" : "canvas-only"}`}
      onPointerDownCapture={handleShellPointerDownCapture}
    >
      {integratedSidebar && (
        <>
      <aside className="metrics-board-rail">
        <button
          type="button"
          className="metrics-board-rail-card"
          onClick={handleOpenDatabaseSidebar}
          title={`Open explorer for ${displayDatabaseLabel}`}
        >
          <Database className="w-4 h-4" />
          <span>{displayDatabaseLabel}</span>
          <small>{displayConnectionLabel}</small>
        </button>

        <button
          type="button"
          className="metrics-board-rail-card active"
          onClick={handleFocusMetricsSidebar}
          title="Focus metrics boards"
        >
          <BarChart3 className="w-4 h-4" />
          <span>Metrics</span>
          <small>{boards.length} board{boards.length === 1 ? "" : "s"}</small>
        </button>
      </aside>

      <aside className="metrics-board-sidebar">
        <div className="metrics-board-sidebar-head">
          <div className="metrics-board-sidebar-copy">
            <span className="metrics-board-sidebar-kicker">Metrics</span>
            <strong className="metrics-board-sidebar-title">Boards</strong>
          </div>
          <span className="metrics-board-sidebar-count">{filteredBoards.length}</span>
        </div>

        <div className="metrics-board-sidebar-search">
          <Search className="w-3.5 h-3.5" />
          <input
            ref={boardSearchInputRef}
            value={boardSearch}
            onChange={(event) => setBoardSearch(event.target.value)}
            placeholder="Search for metrics board..."
          />
          <button type="button" className="metrics-board-inline-action" onClick={createBoard} title="Create metrics board">
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="metrics-board-list">
          {filteredBoards.map((board) => {
            const isActive = board.id === activeBoardId;
            return (
              <div key={board.id} className="metrics-board-list-group">
                <button
                  type="button"
                  className={`metrics-board-list-item ${isActive ? "active" : ""}`}
                  onClick={() => setActiveBoardId(board.id)}
                >
                  {isActive ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  <BarChart3 className="w-3.5 h-3.5" />
                  <div className="metrics-board-list-copy">
                    <span>{board.name}</span>
                    <small>
                      {board.widgets.length} widget{board.widgets.length === 1 ? "" : "s"}
                    </small>
                  </div>
                </button>

                {isActive && board.widgets.length > 0 && (
                  <div className="metrics-board-list-children">
                    {board.widgets.map((widget) => {
                      const Icon = getWidgetLibraryItem(widget.type).icon;
                      return (
                        <button
                          key={widget.id}
                          type="button"
                          className={`metrics-board-list-child ${activeWidgetId === widget.id ? "active" : ""}`}
                          onClick={() => handleWidgetSelection(widget.id)}
                        >
                          <Icon className="w-3 h-3" />
                          <span>{widget.title}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {filteredBoards.length === 0 && (
            <div className="metrics-board-empty-side">No boards match this search.</div>
          )}
        </div>
      </aside>
        </>
      )}

      <div className="metrics-board-main">
        <div className="metrics-board-canvas" ref={canvasRef}>
          <div
            className={`metrics-board-surface ${dragState ? "dragging" : ""}`}
            style={{ width: `${surfaceWidth}px`, minHeight: `${surfaceContentHeight}px` }}
            onContextMenu={openCanvasContextMenu}
          >
            <div className="metrics-board-grid">
              {activeBoard?.widgets.map((widget) => (
                <MetricsWidgetCard
                  key={widget.id}
                  widget={widget}
                  connectionId={connectionId}
                  selected={activeWidgetId === widget.id}
                  dragging={dragState?.widgetId === widget.id}
                  resizing={resizeState?.widgetId === widget.id}
                  layoutStyle={getWidgetLayoutStyle(widget)}
                  onSelect={() => handleWidgetSelection(widget.id)}
                  onDragStart={(clientX, clientY) => handleWidgetDragStart(widget, clientX, clientY)}
                  onResizeStart={(clientX, clientY) => handleWidgetResizeStart(widget, clientX, clientY)}
                />
              ))}
            </div>

            {canvasContextMenu ? (
              <div
                className="metrics-board-context-menu-shell"
                style={{
                  left: `${canvasContextMenu.left}px`,
                  top: `${canvasContextMenu.top}px`,
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <div
                  className="metrics-board-context-trigger"
                  onMouseEnter={() =>
                    setCanvasContextMenu((current) =>
                      current ? { ...current, submenuOpen: true } : current,
                    )
                  }
                  onMouseLeave={() =>
                    setCanvasContextMenu((current) =>
                      current ? { ...current, submenuOpen: false } : current,
                    )
                  }
                >
                  <button
                    type="button"
                    className="metrics-board-context-button"
                    onClick={() =>
                      setCanvasContextMenu((current) =>
                        current ? { ...current, submenuOpen: !current.submenuOpen } : current,
                      )
                    }
                  >
                    <span>{t("metrics.context.add")}</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>

                  {canvasContextMenu.submenuOpen ? (
                    <div className="metrics-board-context-submenu">
                      {getWidgetLibrary().map((item) => {
                        const Icon = item.icon;
                        return (
                          <button
                            key={item.type}
                            type="button"
                            className="metrics-board-context-item"
                            onClick={() =>
                              addWidget(item.type, {
                                grid_x: canvasContextMenu.grid_x,
                                grid_y: canvasContextMenu.grid_y,
                              })
                            }
                          >
                            <Icon className="w-3.5 h-3.5" />
                            <span>{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {editingWidget && widgetEditorLayout ? (
              <div
                className={`metrics-widget-editor metrics-widget-editor-${widgetEditorLayout.side}`}
                style={{
                  left: `${widgetEditorLayout.left}px`,
                  top: `${widgetEditorLayout.top}px`,
                  width: `${widgetEditorLayout.width}px`,
                }}
              >
                <div className="metrics-widget-editor-head">
                  <div className="metrics-widget-editor-copy">
                    <span className="metrics-widget-editor-kicker">{t("metrics.editor.kicker")}</span>
                    <strong className="metrics-widget-editor-title">{editingWidget.title}</strong>
                  </div>
                </div>

                <label className="metrics-board-field">
                  <span>{t("common.label")}</span>
                  <input
                    value={editingWidget.title}
                    onChange={(event) => updateSelectedWidget({ title: event.target.value })}
                  />
                </label>

                <div className="metrics-board-field">
                  <span>{t("common.query")}</span>
                  <div className="metrics-query-editor">
                    <Editor
                      key={editingWidget.id}
                      height="164px"
                      defaultLanguage="sql"
                      theme="tabler-metrics-dark"
                      defaultValue={editingWidget.query}
                      onChange={(value) => setWidgetQueryDraft(value ?? "")}
                      onMount={handleMetricsEditorMount}
                      options={{
                        readOnly: false,
                        domReadOnly: false,
                        minimap: { enabled: false },
                        lineNumbers: "off",
                        glyphMargin: false,
                        folding: false,
                        lineDecorationsWidth: 0,
                        lineNumbersMinChars: 0,
                        overviewRulerBorder: false,
                        hideCursorInOverviewRuler: true,
                        contextmenu: true,
                        scrollBeyondLastLine: false,
                        wordWrap: "on",
                        quickSuggestions: {
                          other: true,
                          comments: false,
                          strings: false,
                        },
                        suggestOnTriggerCharacters: true,
                        acceptSuggestionOnEnter: "on",
                        tabSize: 2,
                        automaticLayout: true,
                        padding: { top: 10, bottom: 10 },
                        scrollbar: {
                          horizontal: "hidden",
                          horizontalScrollbarSize: 0,
                          verticalScrollbarSize: 8,
                          alwaysConsumeMouseWheel: false,
                          useShadows: false,
                        },
                        scrollBeyondLastColumn: 0,
                        fontSize: 12,
                        fontFamily: "JetBrains Mono, Consolas, monospace",
                      }}
                    />
                  </div>
                </div>

                <div className="metrics-board-field-grid">
                  <label className="metrics-board-field">
                    <span>{t("metrics.editor.refreshRate")}</span>
                    <MetricsCompactSelect
                      value={editingWidget.refresh_seconds}
                      options={metricsRefreshOptions}
                      ariaLabel={t("metrics.editor.refreshRate")}
                      onChange={(nextValue) => updateSelectedWidget({ refresh_seconds: Number(nextValue) })}
                    />
                  </label>

                  <label className="metrics-board-field">
                    <span>{t("common.size")}</span>
                    <MetricsCompactSelect
                      value={`${editingWidget.col_span}x${editingWidget.row_span}`}
                      options={metricsSizeOptions}
                      ariaLabel={t("common.size")}
                      onChange={(nextValue) => {
                        const [colSpan, rowSpan] = String(nextValue).split("x").map(Number);
                        updateSelectedWidget({ col_span: colSpan, row_span: rowSpan });
                      }}
                    />
                  </label>
                </div>

                <div className="metrics-board-help compact">
                  {t("metrics.editor.help")}
                </div>

                <div className="metrics-widget-editor-actions">
                  <button
                    type="button"
                    className="metrics-board-btn danger"
                    onClick={deleteSelectedWidget}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{t("common.delete")}</span>
                  </button>
                  <button
                    type="button"
                    className="metrics-board-btn"
                    onClick={clearWidgetSelection}
                  >
                    <span>{t("common.ok")}</span>
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
