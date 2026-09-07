/**
 * Public facade for AI metrics-board templates.
 * Implementation lives under ./metrics-board/*.
 */

import type {
  DatabaseType,
  MetricsBoardDefinition,
  MetricsWidgetDefinition,
} from "../types";

import {
  type AIMetricsBoardTemplate,
  type AIMetricsSchemaTableHint,
  type MetricsTemplateDefinition,
  type OpenAIMetricsBoardDetail,
} from "./metrics-board/shared";
import {
  normalizeAIWidgetType,
  type AIMetricsWidgetSpec,
} from "./metrics-board/shared";
import { getPostgresAdaptiveOverviewTemplate } from "./metrics-board/template-builders";
import {
  canPlaceWidget,
  createUniqueBoardName,
  createWidgetFromSeed,
  findFirstAvailablePosition,
} from "./metrics-board/placement";
import {
  buildMsSqlOverviewSeeds,
  buildMySqlOverviewSeeds,
  buildPostgresOverviewSeeds,
} from "./metrics-board/seeds";

export * from "./metrics-board/shared";

export function buildDatabaseOverviewBoardTemplate(
  dbType?: DatabaseType,
  schemaHints?: AIMetricsSchemaTableHint[],
): MetricsTemplateDefinition | null {
  switch (dbType) {
    case "postgresql":
    case "cockroachdb":
    case "greenplum":
    case "redshift": {
      const adaptiveTemplate = getPostgresAdaptiveOverviewTemplate(schemaHints);
      return {
        title: adaptiveTemplate?.title ?? "DB Overview Dashboard",
        widgets: buildPostgresOverviewSeeds(schemaHints),
      };
    }
    case "mysql":
    case "mariadb":
      return {
        title: "DB Overview Dashboard",
        widgets: buildMySqlOverviewSeeds(),
      };
    case "mssql":
      return {
        title: "DB Overview Dashboard",
        widgets: buildMsSqlOverviewSeeds(),
      };
    default:
      return null;
  }
}

export function getAIMetricsBoardTemplateDefinition(
  template: AIMetricsBoardTemplate,
  dbType?: DatabaseType,
  schemaHints?: AIMetricsSchemaTableHint[],
) {
  if (template === "database-overview") {
    return buildDatabaseOverviewBoardTemplate(dbType, schemaHints);
  }
  return null;
}

export function supportsAIMetricsBoardTemplate(
  template: AIMetricsBoardTemplate,
  dbType?: DatabaseType,
  schemaHints?: AIMetricsSchemaTableHint[],
) {
  return getAIMetricsBoardTemplateDefinition(template, dbType, schemaHints) !== null;
}

export function resolveBoardTitle(
  requestedTitle: string | undefined,
  templateTitle: string,
  fallbackTitle?: string,
) {
  const normalizedRequestedTitle = requestedTitle?.trim();
  if (!normalizedRequestedTitle || normalizedRequestedTitle === "DB Overview Dashboard") {
    return fallbackTitle ?? templateTitle;
  }
  return normalizedRequestedTitle;
}

export function createAIMetricsBoardFromWidgets(args: {
  widgets: AIMetricsWidgetSpec[];
  title?: string;
  database?: string;
  connectionId: string;
  existingBoards: MetricsBoardDefinition[];
}): MetricsBoardDefinition | null {
  const cleaned = args.widgets
    .map((widget) => ({
      title: (widget.title || "").trim(),
      type: normalizeAIWidgetType(widget.type),
      query: (widget.query || "").trim(),
      dimension: widget.dimension?.trim() || undefined,
      measures: (widget.measures || []).map((value) => value.trim()).filter(Boolean).slice(0, 12),
      transforms: (widget.transforms || []).map((value) => value.trim()).filter(Boolean).slice(0, 12),
      limit: Math.min(10_000, Math.max(1, Math.floor(widget.limit || 100))),
    }))
    .filter((widget) => widget.title.length > 0 && widget.query.length > 0)
    .slice(0, 12);

  if (cleaned.length === 0) {
    return null;
  }

  const COLUMNS = 2;
  const now = Date.now();
  const widgets: MetricsWidgetDefinition[] = cleaned.map((widget, index) => {
    // Scoreboards are compact; charts/tables take a full column row.
    const isCompact = widget.type === "scoreboard";
    const colSpan = isCompact ? 1 : 1;
    const rowSpan = widget.type === "table" ? 2 : 1;
    return {
      id: `widget-${crypto.randomUUID()}`,
      type: widget.type,
      title: widget.title,
      query: widget.query,
      refresh_seconds: 0,
      col_span: colSpan,
      row_span: rowSpan,
      grid_x: index % COLUMNS,
      grid_y: Math.floor(index / COLUMNS),
      chart_spec: {
        version: 1,
        source_query: widget.query,
        dimension: widget.dimension,
        measures: widget.measures,
        transforms: widget.transforms,
        limit: widget.limit,
      },
    };
  });

  const requestedTitle = args.title?.trim() && args.title.trim() !== "DB Overview Dashboard"
    ? args.title.trim()
    : "AI Metrics Summary";

  return {
    id: `metrics-${crypto.randomUUID()}`,
    name: createUniqueBoardName(requestedTitle, args.existingBoards),
    connection_id: args.connectionId,
    database: args.database,
    widgets,
    created_at: now,
    updated_at: now,
  } satisfies MetricsBoardDefinition;
}

export function createAIMetricsBoardDefinition(args: {
  detail: OpenAIMetricsBoardDetail;
  dbType?: DatabaseType;
  connectionId: string;
  existingBoards: MetricsBoardDefinition[];
  schemaHints?: AIMetricsSchemaTableHint[];
}) {
  const template = args.detail.template ?? "database-overview";
  const builtTemplate = getAIMetricsBoardTemplateDefinition(template, args.dbType, args.schemaHints);
  if (!builtTemplate) {
    return null;
  }

  const now = Date.now();
  const requestedTitle = resolveBoardTitle(args.detail.title, builtTemplate.title);
  return {
    id: `metrics-${crypto.randomUUID()}`,
    name: createUniqueBoardName(requestedTitle, args.existingBoards),
    connection_id: args.connectionId,
    database: args.detail.database,
    widgets: builtTemplate.widgets.map(createWidgetFromSeed),
    created_at: now,
    updated_at: now,
  } satisfies MetricsBoardDefinition;
}

export function augmentAIMetricsBoardDefinition(args: {
  board: MetricsBoardDefinition;
  detail: OpenAIMetricsBoardDetail;
  dbType?: DatabaseType;
  schemaHints?: AIMetricsSchemaTableHint[];
}) {
  const template = args.detail.template ?? "database-overview";
  const builtTemplate = getAIMetricsBoardTemplateDefinition(template, args.dbType, args.schemaHints);
  if (!builtTemplate) {
    return null;
  }

  const normalizedExistingWidgetKeys = new Set(
    args.board.widgets.map((widget) =>
      `${widget.type}::${widget.title.trim().toLowerCase()}::${widget.query.replace(/\s+/g, " ").trim().toLowerCase()}`,
    ),
  );

  const nextWidgets = [...args.board.widgets];
  let addedCount = 0;
  const addedTitles: string[] = [];
  const addedWidgetIds: string[] = [];

  builtTemplate.widgets.forEach((seed) => {
    const widgetKey = `${seed.type}::${seed.title.trim().toLowerCase()}::${seed.query
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()}`;
    if (normalizedExistingWidgetKeys.has(widgetKey)) {
      return;
    }

    const baseWidget = createWidgetFromSeed(seed);
    const placedWidget = canPlaceWidget(nextWidgets, baseWidget)
      ? baseWidget
      : findFirstAvailablePosition(nextWidgets, baseWidget);

    nextWidgets.push(placedWidget);
    normalizedExistingWidgetKeys.add(widgetKey);
    addedCount += 1;
    addedTitles.push(seed.title);
    addedWidgetIds.push(placedWidget.id);
  });

  return {
    board: {
      ...args.board,
      name: resolveBoardTitle(args.detail.title, builtTemplate.title, args.board.name),
      widgets: nextWidgets,
      updated_at: Date.now(),
    } satisfies MetricsBoardDefinition,
    addedCount,
    addedTitles,
    addedWidgetIds,
  };
}

export function rebuildAIMetricsBoardDefinition(args: {
  board: MetricsBoardDefinition;
  detail: OpenAIMetricsBoardDetail;
  dbType?: DatabaseType;
  schemaHints?: AIMetricsSchemaTableHint[];
}) {
  const template = args.detail.template ?? "database-overview";
  const builtTemplate = getAIMetricsBoardTemplateDefinition(template, args.dbType, args.schemaHints);
  if (!builtTemplate) {
    return null;
  }

  const rebuiltWidgets = builtTemplate.widgets.map(createWidgetFromSeed);

  return {
    board: {
      ...args.board,
      name: resolveBoardTitle(args.detail.title, builtTemplate.title, args.board.name),
      database: args.detail.database ?? args.board.database,
      widgets: rebuiltWidgets,
      updated_at: Date.now(),
    } satisfies MetricsBoardDefinition,
    addedCount: rebuiltWidgets.length,
    addedTitles: rebuiltWidgets.map((widget) => widget.title),
    addedWidgetIds: rebuiltWidgets.map((widget) => widget.id),
  };
}
