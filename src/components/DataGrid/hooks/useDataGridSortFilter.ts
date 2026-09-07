import { useCallback, type Dispatch, type SetStateAction } from "react";

interface DataGridSortFilterParams {
  sortColumn: string | null;
  multiSort: Array<{ column: string; direction: "ASC" | "DESC"; priority: number }>;

  setMultiSort: Dispatch<SetStateAction<Array<{ column: string; direction: "ASC" | "DESC"; priority: number }>>>;
  setSortColumn: Dispatch<SetStateAction<string | null>>;
  setSortDir: Dispatch<SetStateAction<"ASC" | "DESC">>;
  setCurrentPage: Dispatch<SetStateAction<number>>;
  setFilterDraft: Dispatch<SetStateAction<string>>;
}

/**
 * Single- and multi-column sorting plus filter draft handlers.
 * Handlers are moved verbatim from the grid component body.
 */
export function useDataGridSortFilter({
  sortColumn,
  multiSort,

  setMultiSort,
  setSortColumn,
  setSortDir,
  setCurrentPage,
  setFilterDraft,
}: DataGridSortFilterParams) {
  const handleSort = useCallback((colName: string) => {
    if (sortColumn === colName) {
      setSortDir((prev) => (prev === "ASC" ? "DESC" : "ASC"));
    } else {
      setMultiSort([]);
      setSortColumn(colName);
      setSortDir("ASC");
    }
    setCurrentPage(0);
  }, [sortColumn]);

  const handleFilterChange = useCallback((value: string) => {
    setFilterDraft(value);
  }, []);

  /** Add column to multi-sort at specific priority position */
  const handleMultiSortAdd = useCallback((colName: string, direction: "ASC" | "DESC") => {
    setMultiSort((prev) => {
      if (prev.some((s) => s.column === colName)) return prev;
      return [...prev, { column: colName, direction, priority: prev.length + 1 }];
    });
    setCurrentPage(0);
  }, []);

  /** Clear all multi-sort columns */
  const handleMultiSortClear = useCallback(() => {
    setMultiSort([]);
    setSortColumn(null);
    setSortDir("ASC");
    setCurrentPage(0);
  }, []);

  const handleSortAsc = useCallback((colName: string) => {
    if (multiSort.length > 0) {
      handleMultiSortAdd(colName, "ASC");
    } else {
      setSortColumn(colName);
      setSortDir("ASC");
      setCurrentPage(0);
    }
  }, [handleMultiSortAdd, multiSort.length]);

  const handleSortDesc = useCallback((colName: string) => {
    if (multiSort.length > 0) {
      handleMultiSortAdd(colName, "DESC");
    } else {
      setSortColumn(colName);
      setSortDir("DESC");
      setCurrentPage(0);
    }
  }, [handleMultiSortAdd, multiSort.length]);

  return {
    handleSort,
    handleFilterChange,
    handleMultiSortAdd,
    handleMultiSortClear,
    handleSortAsc,
    handleSortDesc,
  };
}
