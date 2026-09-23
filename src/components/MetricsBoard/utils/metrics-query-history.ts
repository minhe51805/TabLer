/**
 * Per-connection query history for the metrics widget editor.
 * Stores the last N distinct queries the user ran, newest first.
 */
const HISTORY_KEY = "tabler.metricsQueryHistory.v1";
const MAX_ENTRIES = 10;

type HistoryMap = Record<string, string[]>;

function readMap(): HistoryMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function readQueryHistory(connectionId: string): string[] {
  return readMap()[connectionId] ?? [];
}

export function pushQueryHistory(connectionId: string, query: string) {
  if (typeof window === "undefined") return;
  const trimmed = query.trim();
  if (!trimmed) return;
  const map = readMap();
  const existing = map[connectionId] ?? [];
  const next = [trimmed, ...existing.filter((q) => q !== trimmed)].slice(0, MAX_ENTRIES);
  map[connectionId] = next;
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(map));
}
