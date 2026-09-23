/**
 * Board-level import/export/duplicate helpers for MetricsBoard.
 * Pure functions — no React, no storage side effects.
 */
import type { MetricsBoardDefinition, MetricsWidgetDefinition } from "../../../types";
import { sanitizeWidgetLayouts } from "./metrics-grid-config";

/** Deep-clone a board with fresh ids so it can coexist with the original. */
export function duplicateBoardDefinition(
  board: MetricsBoardDefinition,
  existingBoards: MetricsBoardDefinition[],
): MetricsBoardDefinition {
  const existingNames = new Set(existingBoards.map((b) => b.name.trim().toLowerCase()));
  let name = `${board.name} copy`;
  let index = 2;
  while (existingNames.has(name.toLowerCase())) {
    name = `${board.name} copy ${index}`;
    index += 1;
  }
  const now = Date.now();
  return {
    ...board,
    id: `board-${crypto.randomUUID()}`,
    name,
    widgets: board.widgets.map((w) => ({ ...w, id: `widget-${crypto.randomUUID()}` })),
    created_at: now,
    updated_at: now,
  };
}

/** Serialize a board to a portable JSON payload (connection-agnostic). */
export function serializeBoard(board: MetricsBoardDefinition): string {
  return JSON.stringify(
    {
      format: "tabler-metrics-board",
      version: 1,
      board: {
        name: board.name,
        database: board.database,
        widgets: board.widgets.map((w) => ({
          type: w.type,
          title: w.title,
          query: w.query,
          refresh_seconds: w.refresh_seconds,
          col_span: w.col_span,
          row_span: w.row_span,
          grid_x: w.grid_x,
          grid_y: w.grid_y,
        })),
      },
    },
    null,
    2,
  );
}

/** Parse a serialized board payload back into a definition bound to a connection. */
export function deserializeBoard(
  raw: string,
  connectionId: string,
  existingBoards: MetricsBoardDefinition[],
): MetricsBoardDefinition | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("board" in parsed)) return null;
  const board: unknown = parsed.board;
  if (!board || typeof board !== "object" || !("name" in board) || !("widgets" in board)) {
    return null;
  }
  if (typeof board.name !== "string" || !Array.isArray(board.widgets)) return null;

  const widgets: MetricsWidgetDefinition[] = [];
  for (const w of board.widgets) {
    if (!w || typeof w !== "object") continue;
    const r = w as Record<string, unknown>;
    if (typeof r.type !== "string" || typeof r.title !== "string" || typeof r.query !== "string") {
      continue;
    }
    widgets.push({
      id: `widget-${crypto.randomUUID()}`,
      type: r.type as MetricsWidgetDefinition["type"],
      title: r.title,
      query: r.query,
      refresh_seconds: typeof r.refresh_seconds === "number" ? r.refresh_seconds : 15,
      col_span: typeof r.col_span === "number" ? r.col_span : 4,
      row_span: typeof r.row_span === "number" ? r.row_span : 4,
      grid_x: typeof r.grid_x === "number" ? r.grid_x : 0,
      grid_y: typeof r.grid_y === "number" ? r.grid_y : 0,
    });
  }

  const existingNames = new Set(existingBoards.map((b) => b.name.trim().toLowerCase()));
  let name = board.name;
  let index = 2;
  while (existingNames.has(name.toLowerCase())) {
    name = `${board.name} ${index}`;
    index += 1;
  }

  const now = Date.now();
  return {
    id: `board-${crypto.randomUUID()}`,
    name,
    connection_id: connectionId,
    database:
      "database" in board && typeof board.database === "string" ? board.database : undefined,
    widgets: sanitizeWidgetLayouts(widgets),
    created_at: now,
    updated_at: now,
  };
}

/** Trigger a browser download of a text payload. */
export function downloadTextFile(content: string, filename: string, mime = "application/json") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
