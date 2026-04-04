/**
 * Column Width Persistence Store.
 * Stores per-table column widths so they survive table navigation and app restarts.
 */

const STORAGE_KEY = "tabler.column-widths";

interface ColumnWidths {
  [scopeKey: string]: Record<string, number>;
}

function loadWidths(): ColumnWidths {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored) as ColumnWidths;
  } catch {
    // ignore
  }
  return {};
}

function saveWidths(widths: ColumnWidths) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // ignore
  }
}

let cachedWidths: ColumnWidths | null = null;

function getAllWidths(): ColumnWidths {
  if (!cachedWidths) {
    cachedWidths = loadWidths();
  }
  return cachedWidths;
}

export function buildColumnWidthScopeKey(
  connectionId: string,
  tableName: string,
  database?: string,
): string {
  return `${connectionId}|${database || ""}|${tableName}`;
}

export function getColumnWidths(
  connectionId: string,
  tableName: string,
  database?: string,
): Record<string, number> {
  const scopeKey = buildColumnWidthScopeKey(connectionId, tableName, database);
  return getAllWidths()[scopeKey] || {};
}

export function saveColumnWidth(
  connectionId: string,
  tableName: string,
  columnId: string,
  width: number,
  database?: string,
): void {
  const scopeKey = buildColumnWidthScopeKey(connectionId, tableName, database);
  const all = getAllWidths();
  if (!all[scopeKey]) all[scopeKey] = {};
  all[scopeKey][columnId] = width;
  cachedWidths = all;
  saveWidths(all);
}

export function clearColumnWidths(
  connectionId: string,
  tableName: string,
  database?: string,
): void {
  const scopeKey = buildColumnWidthScopeKey(connectionId, tableName, database);
  const all = getAllWidths();
  delete all[scopeKey];
  cachedWidths = all;
  saveWidths(all);
}

export function resetAllColumnWidths(): void {
  cachedWidths = {};
  saveWidths({});
}
