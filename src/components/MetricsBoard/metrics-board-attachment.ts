/**
 * Compact metrics-board snapshot builder for AI attachments.
 */

import type { MetricsBoardDefinition } from "../../types";

export const MAX_AI_BOARD_ATTACHMENT_WIDGETS = 16;
export const MAX_AI_BOARD_ATTACHMENT_QUERY_CHARS = 420;

function compactWidgetQueryForAI(query: string) {
  const compact = query.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_AI_BOARD_ATTACHMENT_QUERY_CHARS) {
    return compact;
  }
  return `${compact.slice(0, MAX_AI_BOARD_ATTACHMENT_QUERY_CHARS - 3).trimEnd()}...`;
}

export function buildMetricsBoardAttachmentSnapshot(args: {
  board: MetricsBoardDefinition;
  connectionLabel: string;
  databaseLabel: string;
}) {
  const { board, connectionLabel, databaseLabel } = args;
  const visibleWidgets = board.widgets.slice(
    0,
    MAX_AI_BOARD_ATTACHMENT_WIDGETS,
  );
  const hiddenWidgetCount = Math.max(
    0,
    board.widgets.length - visibleWidgets.length,
  );

  return [
    "Metrics dashboard snapshot:",
    `Board: ${board.name}`,
    `Connection: ${connectionLabel}`,
    `Database: ${databaseLabel}`,
    `Widget count: ${board.widgets.length}`,
    "",
    "Widgets:",
    ...visibleWidgets.map((widget, index) =>
      [
        `${index + 1}. [${widget.type}] ${widget.title}`,
        `   layout: x=${widget.grid_x}, y=${widget.grid_y}, w=${widget.col_span}, h=${widget.row_span}, refresh=${widget.refresh_seconds}s`,
        `   query: ${compactWidgetQueryForAI(widget.query)}`,
      ].join("\n"),
    ),
    hiddenWidgetCount > 0
      ? `... ${hiddenWidgetCount} more widget(s) are present on this dashboard but omitted from this compact snapshot.`
      : "",
    "",
    "Use this dashboard snapshot as the source of truth when recommending edits, removing redundant charts, renaming widgets, or proposing replacements.",
  ]
    .filter(Boolean)
    .join("\n");
}
