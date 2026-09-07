import type { DatabaseType, MetricsWidgetType } from "../../types";

export interface VisualizationSelectionContext {
  text: string;
  source: string;
  boardId?: string;
}

export function hasMetricsDashboardAttachmentContext(prompt: string) {
  return prompt.includes("Metrics dashboard snapshot:");
}

export function isDashboardSelectionSource(source?: string | null) {
  const normalizedSource = source?.trim().toLowerCase() || "";
  return normalizedSource.startsWith("dashboard:");
}

export type DashboardSnapshotWidget = {
  type: MetricsWidgetType;
  title: string;
};

export type DashboardWidgetEditInstruction = {
  boardId?: string;
  targetTitle: string;
  nextType: MetricsWidgetType;
  nextQuery?: string;
  nextTitle?: string;
};

export function extractDashboardSnapshotWidgets(snapshot: string): DashboardSnapshotWidget[] {
  return snapshot
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*\d+\.\s+\[(table|scoreboard|bar|line|pie)\]\s+(.+?)\s*$/i))
    .filter((match): match is RegExpMatchArray => !!match)
    .map((match) => ({
      type: match[1].toLowerCase() as MetricsWidgetType,
      title: match[2].trim(),
    }));
}

export function extractDashboardWidgetTitleFromPrompt(prompt: string) {
  const quotedMatch = prompt.match(/["“”']([^"“”']{2,120})["“”']/);
  if (quotedMatch?.[1]?.trim()) {
    return quotedMatch[1].trim();
  }

  const normalizedPrompt = prompt.trim();
  const chartLeadMatch = normalizedPrompt.match(/\bchart\s+([a-z0-9 _-]{2,120})/i);
  if (chartLeadMatch?.[1]) {
    return chartLeadMatch[1]
      .replace(/\b(no|not|khong|ko)\b.*$/i, "")
      .replace(/\b(doi|change|switch)\b.*$/i, "")
      .trim();
  }

  const widgetLeadMatch = normalizedPrompt.match(/\bwidget\s+([a-z0-9 _-]{2,120})/i);
  if (widgetLeadMatch?.[1]) {
    return widgetLeadMatch[1]
      .replace(/\b(no|not|khong|ko)\b.*$/i, "")
      .replace(/\b(doi|change|switch)\b.*$/i, "")
      .trim();
  }

  return "";
}

export function inferWidgetTypeFromPrompt(prompt: string): MetricsWidgetType | null {
  const normalized = normalizeVisualizationText(prompt);
  if (!normalized) return null;

  if (normalized.includes("scoreboard") || normalized.includes("kpi")) return "scoreboard";
  if (normalized.includes("radial") || normalized.includes("gauge") || normalized.includes("thanh tron")) return "radial";
  if (normalized.includes("donut") || normalized.includes("doughnut") || normalized.includes("vanh khuyen")) return "donut";
  if (normalized.includes("area") || normalized.includes("vung")) return "area";
  if (
    normalized.includes("horizontal") ||
    normalized.includes("cot ngang") ||
    normalized.includes("thanh ngang") ||
    normalized.includes("bar ngang")
  ) {
    return "horizontal-bar";
  }
  if (normalized.includes("line") || normalized.includes("duong")) return "line";
  if (normalized.includes("pie") || normalized.includes("tron")) return "pie";
  if (normalized.includes("bar") || normalized.includes("cot")) return "bar";
  if (normalized.includes("table") || normalized.includes("bang")) return "table";
  if (
    normalized.includes("khong co value") ||
    normalized.includes("khong co gia tri") ||
    normalized.includes("empty") ||
    normalized.includes("rong") ||
    normalized.includes("chart khac") ||
    normalized.includes("doi qua chart khac") ||
    normalized.includes("change chart")
  ) {
    return "table";
  }
  return null;
}

export function extractDashboardWidgetTitleFromConversationContext(conversationText: string) {
  if (!conversationText.trim()) return "";

  const quotedWidgetMatch = conversationText.match(/widget\s+["“”']([^"“”']{2,120})["“”']/i);
  if (quotedWidgetMatch?.[1]?.trim()) {
    return quotedWidgetMatch[1].trim();
  }

  const recommendationMatch = conversationText.match(/recommended change for widget(?:\s+\d+)?\s*:\s*([^\n]+)/i);
  if (recommendationMatch?.[1]?.trim()) {
    return recommendationMatch[1].trim();
  }

  const vietnameseMatch = conversationText.match(/doi chart cho widget\s+["“”']([^"“”']{2,120})["“”']/i);
  if (vietnameseMatch?.[1]?.trim()) {
    return vietnameseMatch[1].trim();
  }

  return "";
}

export function extractDashboardWidgetTargetHint(prompt: string, conversationContext = "") {
  const explicitPromptTitle = extractDashboardWidgetTitleFromPrompt(prompt);
  if (explicitPromptTitle) {
    return explicitPromptTitle;
  }

  const normalizedPrompt = normalizeVisualizationText(prompt);
  const leadMatch = normalizedPrompt.match(
    /\b(?:chart|widget)\s+(.+?)(?=\b(?:no|not|khong|ko|doi|change|switch|thanh|sang|goi y|suggestion|option|phuong an)\b|$)/i,
  );
  if (leadMatch?.[1]?.trim()) {
    return leadMatch[1].trim();
  }

  return extractDashboardWidgetTitleFromConversationContext(conversationContext);
}

export function isDashboardWidgetAdjustmentPrompt(prompt: string) {
  const normalized = normalizeVisualizationText(prompt);
  if (!normalized) return false;

  return [
    "doi chart",
    "doi qua",
    "chart khac",
    "widget",
    "khong co value",
    "khong co gia tri",
    "khong co du lieu",
    "empty",
    "rong",
    "goi y 1",
    "goi y 2",
    "goi y 3",
    "suggestion 1",
    "suggestion 2",
    "suggestion 3",
    "option 1",
    "option 2",
    "option 3",
    "phuong an 1",
    "phuong an 2",
    "phuong an 3",
    "doi thanh",
    "change this",
    "switch this",
    "fix chart",
    "sua chart",
  ].some((signal) => normalized.includes(signal));
}

export function isDashboardAttachmentReferencePrompt(prompt: string) {
  const normalized = normalizeVisualizationText(prompt);
  if (!normalized) return false;

  const dashboardSignals = [
    "dashboard hien tai",
    "board hien tai",
    "chart o dashboard",
    "chart ở dashboard",
    "chart dashboard",
    "day dashboard",
    "dua cho ban",
    "dang dua cho ban",
    "xem dashboard nay",
    "xem board nay",
    "doc dashboard",
    "review dashboard",
    "this dashboard",
    "current dashboard",
    "current board",
    "this board",
    "attached dashboard",
  ];

  return dashboardSignals.some((signal) => normalized.includes(normalizeVisualizationText(signal)));
}

export function inferWidgetTypeFromPromptWithContext(prompt: string, conversationContext = ""): MetricsWidgetType | null {
  const directType = inferWidgetTypeFromPrompt(prompt);
  if (directType) {
    return directType;
  }

  const normalizedPrompt = normalizeVisualizationText(prompt);
  const normalizedConversation = normalizeVisualizationText(conversationContext);

  if (!normalizedPrompt) return null;

  if (/(?:goi y|suggestion|option|phuong an)\s*1/.test(normalizedPrompt)) {
    if (normalizedConversation.includes("kpi") || normalizedConversation.includes("metric")) {
      return "scoreboard";
    }
    if (normalizedConversation.includes("table")) {
      return "table";
    }
  }

  if (/(?:goi y|suggestion|option|phuong an)\s*2/.test(normalizedPrompt) && normalizedConversation.includes("table")) {
    return "table";
  }

  return null;
}

export function buildAverageRatingTableQuery() {
  return [
    "SELECT",
    `  COALESCE(NULLIF(TRIM(p."name"::text), ''), 'Product #' || COALESCE(p."id"::text, 'n/a')) AS product,`,
    `  COUNT(r."product_id")::bigint AS review_count,`,
    `  COALESCE(ROUND(AVG(r."rating"::numeric), 2), 0) AS avg_rating`,
    `FROM "public"."products" p`,
    `LEFT JOIN "public"."reviews" r ON p."id"::text = r."product_id"::text`,
    `WHERE p."id" IS NOT NULL`,
    "GROUP BY 1",
    "ORDER BY avg_rating DESC, product ASC",
    "LIMIT 10;",
  ].join("\n");
}

export function buildOAuthClientsScoreboardQuery() {
  return [
    "SELECT",
    "  COUNT(*)::bigint AS total_clients,",
    "  'oauth clients' AS label",
    'FROM "auth"."oauth_clients";',
  ].join("\n");
}

export function summarizeAttachedDashboardSelection(selection: VisualizationSelectionContext) {
  const boardNameMatch = selection.text.match(/^Board:\s+(.+)$/mi);
  const widgetCountMatch = selection.text.match(/^Widget count:\s+(\d+)$/mi);
  const hiddenWidgetCountMatch = selection.text.match(/\.\.\.\s+(\d+)\s+more widget\(s\)/i);
  const widgets = extractDashboardSnapshotWidgets(selection.text);

  return {
    boardName: boardNameMatch?.[1]?.trim() || selection.source.replace(/^dashboard:\s*/i, "").trim() || "Current dashboard",
    widgetCount: Number(widgetCountMatch?.[1] || widgets.length || 0),
    hiddenWidgetCount: Number(hiddenWidgetCountMatch?.[1] || 0),
    widgetTitles: widgets.map((widget) => widget.title),
  };
}

export function resolveDashboardWidgetEditInstruction(
  prompt: string,
  selection: VisualizationSelectionContext | null,
  conversationContext = "",
): DashboardWidgetEditInstruction | null {
  if (!selection || !isDashboardSelectionSource(selection.source)) return null;

  const normalizedPrompt = normalizeVisualizationText(prompt);
  if (!normalizedPrompt) return null;

  const nextType = inferWidgetTypeFromPromptWithContext(prompt, conversationContext);
  if (!nextType) return null;

  const widgets = extractDashboardSnapshotWidgets(selection.text);
  const explicitTargetTitle = extractDashboardWidgetTargetHint(prompt, conversationContext);
  const normalizedExplicitTargetTitle = normalizeVisualizationText(explicitTargetTitle);

  const matchingWidget =
    widgets.length === 0
      ? null
      : [...widgets]
          .sort((left, right) => right.title.length - left.title.length)
          .find((widget) => {
            const normalizedWidgetTitle = normalizeVisualizationText(widget.title);
            return (
              normalizedPrompt.includes(normalizedWidgetTitle) ||
              (!!normalizedExplicitTargetTitle && (
                normalizedExplicitTargetTitle === normalizedWidgetTitle ||
                normalizedExplicitTargetTitle.includes(normalizedWidgetTitle) ||
                normalizedWidgetTitle.includes(normalizedExplicitTargetTitle)
              ))
            );
          });

  const resolvedTargetTitle = matchingWidget?.title || explicitTargetTitle;
  if (!resolvedTargetTitle) return null;

  const normalizedTitle = normalizeVisualizationText(resolvedTargetTitle);
  const isAverageRatingWidget =
    normalizedTitle === "average rating by product" || normalizedTitle === "reviews by product";
  const isOAuthClientsWidget = normalizedTitle === "oauth clients";

  return {
    boardId: selection.boardId,
    targetTitle: resolvedTargetTitle,
    nextType,
    nextQuery:
      isAverageRatingWidget && nextType === "table"
        ? buildAverageRatingTableQuery()
        : isOAuthClientsWidget
          ? buildOAuthClientsScoreboardQuery()
          : undefined,
  };
}

export async function waitForUIPaint() {
  await new Promise<void>((resolve) => {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        window.setTimeout(resolve, 0);
      });
      return;
    }

    setTimeout(resolve, 0);
  });
}

export function isVisualizationPrompt(prompt: string) {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return false;

  return [
    "chart",
    "charts",
    "visual",
    "visual data",
    "viz",
    "graph",
    "plot",
    "dashboard",
    "visualize",
    "visualization",
    "bar chart",
    "line chart",
    "pie chart",
    "bieu do",
    "biểu đồ",
    "ve bieu do",
    "vẽ biểu đồ",
  ].some((signal) => normalized.includes(signal));
}

export function normalizeVisualizationText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .trim();
}

export function prefersVietnameseSystemReply(prompt: string, uiLanguage: string) {
  if (uiLanguage === "vi") return true;
  const normalizedPrompt = normalizeVisualizationText(prompt);
  if (!normalizedPrompt) return false;

  return [
    "xem",
    "bieu do",
    "bo sung",
    "them",
    "thieu",
    "day du",
    "giu",
    "doi",
    "hien tai",
    "duoc khong",
    "cho tui",
    "giup tui",
  ].some((signal) => normalizedPrompt.includes(signal));
}

export function supportsOverviewMetricsBoard(dbType?: DatabaseType) {
  switch (dbType) {
    case "postgresql":
    case "cockroachdb":
    case "greenplum":
    case "redshift":
    case "mysql":
    case "mariadb":
    case "mssql":
      return true;
    default:
      return false;
  }
}

export function isDashboardVisualizationPrompt(prompt: string, intent?: string) {
  const normalizedPrompt = normalizeVisualizationText(prompt);
  if (!normalizedPrompt) return false;

  const dashboardSignals = [
    "dashboard",
    "multi chart",
    "multiple charts",
    "many charts",
    "nhieu bieu do",
    "nhiều biểu đồ",
    "nhieu chart",
    "nhiều chart",
    "metrics board",
    "metrics",
    "metric board",
    "bang metric",
    "bảng metric",
    "o metric",
    "ở metric",
  ];

  return (
    isOverviewVisualizationPrompt(prompt, intent) ||
    (isVisualizationPrompt(normalizedPrompt) &&
      dashboardSignals.some((signal) => normalizedPrompt.includes(signal)))
  );
}

export function isDashboardAugmentPrompt(prompt: string) {
  const normalizedPrompt = normalizeVisualizationText(prompt);
  if (!normalizedPrompt || !isVisualizationPrompt(normalizedPrompt)) {
    return false;
  }

  const augmentSignals = [
    "add chart",
    "add more chart",
    "add more charts",
    "more chart",
    "more charts",
    "missing chart",
    "missing charts",
    "complete chart",
    "complete dashboard",
    "fill out dashboard",
    "expand dashboard",
    "augment dashboard",
    "bo sung",
    "them bieu do",
    "them chart",
    "thieu",
    "day du",
    "lam day",
    "bo sung them",
    "chi tiet",
    "chi tiet hon",
    "bao quat",
    "bao quat hon",
    "tung bang",
    "moi bang",
    "per table",
    "detail visual",
    "sua chart",
    "refine dashboard",
  ];

  return augmentSignals.some((signal) => normalizedPrompt.includes(signal));
}

export function isDashboardRebuildPrompt(prompt: string) {
  const normalizedPrompt = normalizeVisualizationText(prompt);
  if (!normalizedPrompt) return false;

  const rebuildSignals = [
    "doi lai",
    "chua duoc",
    "xem het",
    "xem them",
    "tong hop",
    "tong quat",
    "bao quat",
    "bao quat hon",
    "chi tiet",
    "chi tiet hon",
    "lam lai",
    "sua lai",
    "lam moi",
    "chart thua",
    "bieu do thua",
    "qua nhieu chart",
    "qua nhieu bieu do",
    "xoa bot",
    "bo chart thua",
    "vo nghia",
    "khong co bao cao",
    "khong bao quat",
    "khong co du lieu gi",
    "khong co du lieu",
    "table khac",
    "tables khac",
    "cac bang khac",
    "other tables",
    "all tables",
    "look through",
    "review all",
    "rebuild dashboard",
    "refresh dashboard",
    "summarize all",
    "cover more",
  ];

  return rebuildSignals.some((signal) => normalizedPrompt.includes(signal));
}

export function buildWorkspaceOverviewChartSql(dbType?: DatabaseType) {
  switch (dbType) {
    case "postgresql":
    case "cockroachdb":
    case "greenplum":
    case "redshift":
      return [
        "SELECT",
        "  relname AS label,",
        "  COALESCE(n_live_tup, 0)::bigint AS value",
        "FROM pg_stat_user_tables",
        "WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
        "ORDER BY value DESC NULLS LAST, label ASC",
        "LIMIT 12;",
      ].join("\n");
    case "mysql":
    case "mariadb":
      return [
        "SELECT",
        "  table_name AS label,",
        "  COALESCE(table_rows, 0) AS value",
        "FROM information_schema.tables",
        "WHERE table_schema = DATABASE()",
        "ORDER BY value DESC, label ASC",
        "LIMIT 12;",
      ].join("\n");
    case "mssql":
      return [
        "SELECT TOP (12)",
        "  t.name AS label,",
        "  SUM(p.rows) AS value",
        "FROM sys.tables t",
        "JOIN sys.partitions p",
        "  ON t.object_id = p.object_id",
        " AND p.index_id IN (0, 1)",
        "GROUP BY t.name",
        "ORDER BY value DESC, label ASC;",
      ].join("\n");
    default:
      return null;
  }
}

export function isOverviewVisualizationPrompt(prompt: string, intent?: string) {
  const normalizedPrompt = prompt.trim().toLowerCase();
  const overviewSignals = [
    "overview",
    "database overview",
    "schema overview",
    "tong quan",
    "tổng quan",
    "overview db",
    "overview database",
  ];

  const hasOverviewSignal =
    intent === "overview" || overviewSignals.some((signal) => normalizedPrompt.includes(signal));

  return hasOverviewSignal && isVisualizationPrompt(normalizedPrompt);
}
