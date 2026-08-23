/**
 * Widget library catalog, select options and label helpers.
 */

import {
  Activity,
  BarChart3,
  ChartColumnStacked,
  Donut,
  Gauge,
  Hash,
  LineChart,
  PieChart,
  Table2,
} from "lucide-react";
import type { MetricsWidgetType } from "../../../types";
import { translateCurrent, type TranslationKey } from "../../../i18n";

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

const REFRESH_OPTIONS = [0, 5, 15, 30, 60, 300] as const;

// ---------------------------------------------------------------------------
// Widget library
// ---------------------------------------------------------------------------

export const WIDGET_LIBRARY: WidgetLibraryBlueprint[] = [
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
  {
    type: "horizontal-bar",
    labelKey: "metrics.widget.horizontalBar",
    description: "Compare category totals as horizontal bars.",
    icon: ChartColumnStacked,
    titleKey: "metrics.widget.untitledHorizontalBar",
    defaultQuery:
      "SELECT 'Alpha' AS label, 32 AS value UNION ALL SELECT 'Beta', 21 UNION ALL SELECT 'Gamma', 14",
    colSpan: 4,
    rowSpan: 4,
  },
  {
    type: "area",
    labelKey: "metrics.widget.area",
    description: "Show a filled trend across two columns.",
    icon: Activity,
    titleKey: "metrics.widget.untitledArea",
    defaultQuery:
      "SELECT 'Jan' AS label, 11 AS value UNION ALL SELECT 'Feb', 18 UNION ALL SELECT 'Mar', 15 UNION ALL SELECT 'Apr', 23",
    colSpan: 4,
    rowSpan: 4,
  },
  {
    type: "donut",
    labelKey: "metrics.widget.donut",
    description: "Ring chart of category share from two columns.",
    icon: Donut,
    titleKey: "metrics.widget.untitledDonut",
    defaultQuery:
      "SELECT 'Done' AS label, 72 AS value UNION ALL SELECT 'Pending', 18 UNION ALL SELECT 'Blocked', 10",
    colSpan: 4,
    rowSpan: 4,
  },
  {
    type: "radial",
    labelKey: "metrics.widget.radial",
    description: "Concentric progress rings from two columns.",
    icon: Gauge,
    titleKey: "metrics.widget.untitledRadial",
    defaultQuery:
      "SELECT 'Target A' AS label, 80 AS value UNION ALL SELECT 'Target B', 55 UNION ALL SELECT 'Target C', 30",
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
