/**
 * Shared types and layout data for AI metrics-board templates.
 */

import type { MetricsWidgetType } from "../../types";

export type AIMetricsBoardTemplate = "database-overview";
export type AIMetricsBoardMode = "create" | "augment" | "rebuild" | "edit";

export interface OpenAIMetricsBoardDetail {
  requestId?: string;
  connectionId?: string;
  database?: string;
  title?: string;
  template?: AIMetricsBoardTemplate;
  mode?: AIMetricsBoardMode;
  boardId?: string;
  focusWorkspace?: boolean;
  editTargetTitle?: string;
  editTargetType?: MetricsWidgetType;
  editQuery?: string;
  editTitle?: string;
  /** When set, build the board directly from these AI-designed widgets. */
  aiWidgets?: AIMetricsWidgetSpec[];
}

export interface OpenAIMetricsBoardCompletionDetail {
  requestId?: string;
  success?: boolean;
  error?: string;
  boardId?: string;
  didChange?: boolean;
  addedCount?: number;
  addedTitles?: string[];
  addedWidgetIds?: string[];
  created?: boolean;
}

export interface MetricsWidgetSeed {
  type: MetricsWidgetType;
  title: string;
  query: string;
  refreshSeconds?: number;
  colSpan: number;
  rowSpan: number;
  gridX: number;
  gridY: number;
}

export interface AIMetricsSchemaTableHint {
  name: string;
  schema?: string;
  rowCount?: number | null;
  columns?: string[];
}

export interface MetricsTemplateDefinition {
  title: string;
  widgets: MetricsWidgetSeed[];
}

export interface MetricsWidgetSeedDraft {
  type: MetricsWidgetType;
  title: string;
  query: string;
  refreshSeconds?: number;
}

export const RECRUITMENT_LAYOUT_SLOTS = [
  { colSpan: 3, rowSpan: 3, gridX: 0, gridY: 0 },
  { colSpan: 3, rowSpan: 3, gridX: 3, gridY: 0 },
  { colSpan: 3, rowSpan: 3, gridX: 6, gridY: 0 },
  { colSpan: 3, rowSpan: 3, gridX: 9, gridY: 0 },
  { colSpan: 4, rowSpan: 4, gridX: 0, gridY: 4 },
  { colSpan: 6, rowSpan: 4, gridX: 4, gridY: 4 },
  { colSpan: 4, rowSpan: 4, gridX: 10, gridY: 4 },
  { colSpan: 6, rowSpan: 4, gridX: 0, gridY: 8 },
  { colSpan: 4, rowSpan: 4, gridX: 6, gridY: 8 },
  { colSpan: 4, rowSpan: 4, gridX: 10, gridY: 8 },
  { colSpan: 7, rowSpan: 4, gridX: 0, gridY: 12 },
  { colSpan: 7, rowSpan: 4, gridX: 7, gridY: 12 },
];

export interface AIMetricsWidgetSpec {
  title: string;
  type: MetricsWidgetType;
  query: string;
  dimension?: string;
  measures?: string[];
  transforms?: string[];
  limit?: number;
}

export const VALID_METRICS_WIDGET_TYPES: MetricsWidgetType[] = ["table", "scoreboard", "bar", "horizontal-bar", "line", "area", "pie", "donut", "radial"];

export function normalizeAIWidgetType(value: unknown): MetricsWidgetType {
  return typeof value === "string" && (VALID_METRICS_WIDGET_TYPES as string[]).includes(value)
    ? (value as MetricsWidgetType)
    : "table";
}

/**
 * Builds a metrics board directly from widgets the AI agent designed, laying
 * them out in a responsive 2-column grid. Used when the agent returns concrete
 * widget specs (title + chart type + SQL) instead of relying on a fixed template.
 */
