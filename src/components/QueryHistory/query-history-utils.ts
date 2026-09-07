/**
 * Pure formatting/grouping helpers and UI copy for the query history panel.
 */

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

export function getHistoryCopy(language: string, activeConnectionId: string | null, selectedCount: number) {
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
      clearTitle: activeConnectionId ? "Xoa tat ca cua connection" : "Xoa tat ca",
      selectAllVisible: "Chon tat ca dang hien",
      deleteSelected: "Xoa da chon",
      selectedCount: `${selectedCount} muc da chon`,
      clearConfirm: activeConnectionId
        ? "Xoa toan bo lich su truy van cua connection hien tai?"
        : "Xoa toan bo lich su truy van?",
      deleteConfirm: "Xoa muc lich su truy van nay?",
      deleteSelectedConfirm: `Xoa ${selectedCount} muc da chon?`,
      today: "Hom nay",
      yesterday: "Hom qua",
      unknownDay: "Khong ro ngay",
      queries: "query",
      ok: "OK",
      errors: "loi",
      rows: "dong",
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
    clearTitle: activeConnectionId ? "Clear current connection" : "Clear all",
    selectAllVisible: "Select visible",
    deleteSelected: "Delete selected",
    selectedCount: `${selectedCount} selected`,
    clearConfirm: activeConnectionId
      ? "Clear the query history for the current connection?"
      : "Clear the entire query history?",
    deleteConfirm: "Delete this query history entry?",
    deleteSelectedConfirm: `Delete ${selectedCount} selected entries?`,
    today: "Today",
    yesterday: "Yesterday",
    unknownDay: "Unknown day",
    queries: "queries",
    ok: "OK",
    errors: "errors",
    rows: "rows",
  };
}

export function getDayKey(iso: string) {
  const date = parseHistoryDate(iso);
  return date ? getDayKeyFromDate(date) : "unknown";
}

export function getDayLabel(iso: string, copy: ReturnType<typeof getHistoryCopy>) {
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
