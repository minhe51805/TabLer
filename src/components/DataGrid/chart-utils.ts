/**
 * Pure chart configuration and data transforms for the query-results chart view.
 */

import { Activity, BarChart3, ChartArea, ChartColumnStacked, ChartLine, ChartScatter, Layers, ChartPie, Spline, Donut, RadarIcon, Gauge, type LucideIcon } from "lucide-react";
import type { ResolvedColumn } from "./hooks/useDataGrid";
import type { QueryResult } from "../../types";

export type ChartType =
  | "bar"
  | "bar-horizontal"
  | "bar-stacked"
  | "line"
  | "line-smooth"
  | "area"
  | "area-stacked"
  | "composed"
  | "scatter"
  | "pie"
  | "donut"
  | "radar"
  | "radial";

export interface DataChartProps {
  resolvedColumns: ResolvedColumn[];
  queryResult: QueryResult | null;
}

export interface ScatterSeries {
  name: string;
  data: Array<{ x: number; y: number; label: string }>;
}

export interface ChartTypeMeta {
  type: ChartType;
  label: string;
  icon: LucideIcon;
  /** Charts that compare categories against a single aggregated value. */
  singleValue?: boolean;
}

export const CHART_TYPES: ChartTypeMeta[] = [
  { type: "bar", label: "Bar", icon: BarChart3 },
  { type: "bar-horizontal", label: "Horizontal", icon: ChartColumnStacked },
  { type: "bar-stacked", label: "Stacked", icon: Layers },
  { type: "line", label: "Line", icon: ChartLine },
  { type: "line-smooth", label: "Smooth", icon: Spline },
  { type: "area", label: "Area", icon: ChartArea },
  { type: "area-stacked", label: "Stacked area", icon: Activity },
  { type: "composed", label: "Bar + line", icon: Activity },
  { type: "scatter", label: "Scatter", icon: ChartScatter },
  { type: "pie", label: "Pie", icon: ChartPie, singleValue: true },
  { type: "donut", label: "Donut", icon: Donut, singleValue: true },
  { type: "radar", label: "Radar", icon: RadarIcon },
  { type: "radial", label: "Radial", icon: Gauge, singleValue: true },
];

export const SERIES_COLORS = [
  "var(--accent)",
  "#22c55e",
  "#06b6d4",
  "#f59e0b",
  "#8b5cf6",
  "#10b981",
  "#ef4444",
  "#3b82f6",
  "#84cc16",
  "#f97316",
  "#ec4899",
  "#14b8a6",
];

export function colorAt(index: number) {
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

export function isNumericByType(column: ResolvedColumn) {
  const type = (column.column_type || column.data_type || "").toLowerCase();
  return (
    /^(smallint|bigint|tinyint|integer|int2|int4|int8|oid)$/.test(type) ||
    /^(real|double|double precision|serial|bigserial)$/.test(type) ||
    /\b(int|real|double|numeric|decimal|float|money|currency)\b/.test(type) ||
    type.startsWith("int")
  );
}

export function tryParseNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function hasNumericValues(rows: unknown[][], columnIndex: number) {
  return rows.some((row) => tryParseNumeric(row[columnIndex]) !== null);
}

export function isNumericColumn(column: ResolvedColumn, rows: unknown[][], columnIndex: number) {
  return isNumericByType(column) || hasNumericValues(rows, columnIndex);
}

export function detectXAxis(columns: ResolvedColumn[], rows: unknown[][]) {
  const priorities = [
    /^(label|name|title|category|type|status|region|country|city|month|day|date)$/i,
    /(^created|^updated|^modified|_at$|time|timestamp)/i,
  ];

  for (const matcher of priorities) {
    const match = columns.find((column) => matcher.test(column.name));
    if (match) return match;
  }

  const firstCategorical = columns.find((column, index) => !isNumericColumn(column, rows, index));
  return firstCategorical || columns[0];
}

export function formatCategoryValue(value: unknown, rowIndex: number) {
  if (value === null || value === undefined || value === "") {
    return `Row ${rowIndex + 1}`;
  }
  return String(value);
}

export function formatAxisTick(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return text.length > 18 ? `${text.slice(0, 15)}...` : text;
}

export function formatNumberTick(value: unknown) {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return String(value ?? "");
  const abs = Math.abs(num);
  if (abs >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}

export function cleanSeries(keys: string[], data: Record<string, unknown>[]) {
  return keys.filter((key) =>
    data.some((row) => typeof row[key] === "number" && Number.isFinite(row[key] as number))
  );
}

export const AXIS_TICK = { fill: "var(--text-secondary)", fontSize: 11 };
export const GRID_STROKE = "var(--border-subtle)";
export const MAX_CHART_POINTS = 480;
export const MAX_CATEGORY_BUCKETS = 24;

export function selectRelevantChartTypes(isTemporalXAxis: boolean, numericMetricCount: number): ChartType[] {
  if (isTemporalXAxis) return ["line", "area", "bar"];
  return numericMetricCount >= 2 ? ["bar", "donut", "scatter"] : ["bar", "donut"];
}

export function isTemporalColumn(column: ResolvedColumn | undefined) {
  if (!column) return false;
  const type = (column.column_type || column.data_type || "").toLowerCase();
  return /date|time|timestamp/.test(type) || /(^|_)(date|time|month|day|year|created|updated|modified)(_at)?$/i.test(column.name);
}

export function sampleChartRows(rows: unknown[][], maxPoints = MAX_CHART_POINTS) {
  if (rows.length <= maxPoints) return rows;
  const step = (rows.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => rows[Math.round(index * step)]);
}

export function aggregateChartRows(
  data: Record<string, unknown>[],
  xKey: string,
  yKeys: string[],
  maxBuckets = MAX_CATEGORY_BUCKETS,
) {
  const buckets = new Map<string, Record<string, unknown>>();
  data.forEach((row, rowIndex) => {
    const label = formatCategoryValue(row[xKey], rowIndex);
    const bucket = buckets.get(label) ?? { [xKey]: label };
    yKeys.forEach((key) => {
      const value = tryParseNumeric(row[key]);
      if (value !== null) bucket[key] = (tryParseNumeric(bucket[key]) ?? 0) + value;
    });
    buckets.set(label, bucket);
  });

  const primaryKey = yKeys[0];
  return [...buckets.values()]
    .sort((left, right) => (tryParseNumeric(right[primaryKey]) ?? 0) - (tryParseNumeric(left[primaryKey]) ?? 0))
    .slice(0, maxBuckets);
}
