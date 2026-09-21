/**
 * Pure formatting/grouping helpers and UI copy for the query history panel.
 */

import type { QueryHistoryEntry } from "../../types";

export type HistoryStatusFilter = "all" | "ok" | "error";
export type HistoryDateFilter = "all" | "today" | "7d" | "30d";
export type HistorySort = "recent" | "duration" | "rows";

export function parseHistoryDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getDayKeyFromDate(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "--";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

export function formatTimestamp(iso: string): string {
  const date = parseHistoryDate(iso);
  if (!date) return iso || "--";
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;

  return date.toLocaleDateString();
}

export function truncateQuery(sql: string, maxChars = 100): string {
  const compact = sql.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}...`;
}

export function getHistoryCopy(
  language: string,
  connectionScope: string | null,
  selectedCount: number,
) {
  if (language === "vi") {
    return {
      panelTitle: "Lich su truy van",
      searchPlaceholder: "Tim query...",
      loading: "Dang tai...",
      noMatches: "Khong tim thay query phu hop.",
      noHistory: "Chua co lich su truy van. Hay chay query de no hien o day.",
      copyTitle: "Sao chep query",
      runTitle: "Chay query",
      deleteTitle: "Xoa muc nay",
      clearTitle: connectionScope ? "Xoa tat ca cua connection" : "Xoa tat ca",
      selectAllVisible: "Chon tat ca dang hien",
      deleteSelected: "Xoa da chon",
      selectedCount: `${selectedCount} muc da chon`,
      today: "Hom nay",
      yesterday: "Hom qua",
      unknownDay: "Khong ro ngay",
      queries: "query",
      ok: "OK",
      errors: "loi",
      rows: "dong",
      filterAllConnections: "Tat ca connection",
      filterStatusAll: "Tat ca trang thai",
      filterStatusOk: "Thanh cong",
      filterStatusError: "Loi",
      filterDateAll: "Moi thoi gian",
      filterDateToday: "Hom nay",
      filterDate7d: "7 ngay qua",
      filterDate30d: "30 ngay qua",
      sortRecent: "Moi nhat",
      sortDuration: "Thoi gian chay",
      sortRows: "So dong",
      favoriteTitle: "Luu vao favorites",
      favoriteSaved: "Da luu vao favorites",
      favoriteFailed: "Khong luu duoc favorite",
    };
  }

  return {
    panelTitle: "Query History",
    searchPlaceholder: "Search queries...",
    loading: "Loading...",
    noMatches: "No matching queries found.",
    noHistory: "No query history yet. Run a query to see it here.",
    copyTitle: "Copy query",
    runTitle: "Run query",
    deleteTitle: "Delete this entry",
    clearTitle: connectionScope ? "Clear current connection" : "Clear all",
    selectAllVisible: "Select visible",
    deleteSelected: "Delete selected",
    selectedCount: `${selectedCount} selected`,
    today: "Today",
    yesterday: "Yesterday",
    unknownDay: "Unknown day",
    queries: "queries",
    ok: "OK",
    errors: "errors",
    rows: "rows",
    filterAllConnections: "All connections",
    filterStatusAll: "All statuses",
    filterStatusOk: "Success",
    filterStatusError: "Error",
    filterDateAll: "All time",
    filterDateToday: "Today",
    filterDate7d: "Last 7 days",
    filterDate30d: "Last 30 days",
    sortRecent: "Most recent",
    sortDuration: "Duration",
    sortRows: "Rows",
    favoriteTitle: "Save to favorites",
    favoriteSaved: "Saved to favorites",
    favoriteFailed: "Could not save favorite",
  };
}

export function getDayKey(iso: string) {
  const date = parseHistoryDate(iso);
  return date ? getDayKeyFromDate(date) : "unknown";
}

export function getDayLabel(iso: string, copy: HistoryCopy) {
  const date = parseHistoryDate(iso);
  if (!date) return copy.unknownDay;
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (getDayKeyFromDate(date) === getDayKeyFromDate(today)) {
    return copy.today;
  }

  if (getDayKeyFromDate(date) === getDayKeyFromDate(yesterday)) {
    return copy.yesterday;
  }

  return date.toLocaleDateString();
}

/** Applies status + date filters to loaded entries (text search runs in the backend). */
export function filterHistoryEntries(
  entries: QueryHistoryEntry[],
  status: HistoryStatusFilter,
  dateRange: HistoryDateFilter,
  now: Date = new Date(),
): QueryHistoryEntry[] {
  return entries.filter((entry) => {
    if (status === "ok" && entry.error) return false;
    if (status === "error" && !entry.error) return false;
    if (dateRange === "all") return true;
    const date = parseHistoryDate(entry.executed_at);
    if (!date) return false;
    if (dateRange === "today") {
      return getDayKeyFromDate(date) === getDayKeyFromDate(now);
    }
    const days = dateRange === "7d" ? 7 : 30;
    return date.getTime() >= now.getTime() - days * 86_400_000;
  });
}

/** UI copy bundle returned by {@link getHistoryCopy}. */
export type HistoryCopy = ReturnType<typeof getHistoryCopy>;

/** Returns a sorted copy; "recent" keeps the backend's newest-first order. */
export function sortHistoryEntries(
  entries: QueryHistoryEntry[],
  sort: HistorySort,
): QueryHistoryEntry[] {
  if (sort === "recent") return entries;
  const sorted = [...entries];
  if (sort === "duration") {
    sorted.sort((a, b) => b.duration_ms - a.duration_ms);
  } else {
    sorted.sort((a, b) => (b.row_count ?? -1) - (a.row_count ?? -1));
  }
  return sorted;
}
