/**
 * Copy for the core DataGrid surface: grid chrome labels, row-header hints,
 * row-mutation feedback, and the drag-reorder prompt. Kept out of src/i18n
 * per the per-feature copy-module convention; English is the fallback for
 * every language until translations land.
 */

import type { AppLanguage } from "../../i18n";

export interface DataGridCopy {
  grid: {
    ariaLabelTable: (tableName: string) => string;
    ariaLabelResult: string;
    loadingChart: string;
    noRows: string;
    copied: string;
    filterLoadedOnly: string;
  };
  rowHeader: {
    clearSelectedRows: string;
    selectAllVisibleRows: string;
    rowSelected: string;
    selectRowInspect: string;
  };
  deleteRows: {
    /** Every selected row is hidden by the quick filter — nothing can run. */
    hiddenOnly: string;
    /** Appended to the confirm text when part of the selection is filtered out. */
    hiddenNote: (count: number) => string;
    confirm: (count: number, tableName: string, hiddenNote: string) => string;
    partialTitle: string;
    partialDescription: (deleted: number, requested: number) => string;
  };
  reorder: {
    noOrderColumn: string;
    confirm: (
      tableName: string,
      orderColumn: string,
      sourceValue: unknown,
      targetValue: unknown,
      sql: string,
    ) => string;
  };
  /** FK lookup cell editor (owned by the grid-data slice — copy lives here). */
  fkLookup: {
    loading: string;
    error: (detail: string) => string;
    referenceUnavailable: string;
    searchPlaceholder: (table: string) => string;
    noMatches: string;
    valueCount: (count: number) => string;
  };
}

const EN_COPY: DataGridCopy = {
  grid: {
    ariaLabelTable: (tableName) => `${tableName} data grid`,
    ariaLabelResult: "Query result data grid",
    loadingChart: "Loading chart...",
    noRows: "No rows to display",
    copied: "Copied",
    filterLoadedOnly: "Filtering loaded rows only",
  },
  rowHeader: {
    clearSelectedRows: "Clear selected rows",
    selectAllVisibleRows: "Select all visible rows",
    rowSelected: "Row selected",
    selectRowInspect: "Select row, double-click to inspect",
  },
  deleteRows: {
    hiddenOnly:
      "The selected rows are hidden by the current filter. Clear the filter to delete them.",
    hiddenNote: (count) =>
      ` ${count} selected row${count === 1 ? " is" : "s are"} hidden by the current filter and will be kept.`,
    confirm: (count, tableName, hiddenNote) =>
      `Delete ${count} selected row${count === 1 ? "" : "s"} from ${tableName}?${hiddenNote} This cannot be undone.`,
    partialTitle: "Some rows were not deleted",
    partialDescription: (deleted, requested) =>
      `The database deleted ${deleted} of ${requested} selected rows. The grid has been refreshed — review the remaining rows and retry if needed.`,
  },
  reorder: {
    noOrderColumn:
      "Cannot reorder rows: table has no sequence column (e.g., row_order, sort_order, position, seq). Add one to enable drag-and-drop reordering.",
    confirm: (tableName, orderColumn, sourceValue, targetValue, sql) =>
      `Reorder rows?\n\nSource: ${tableName}[${orderColumn}] = ${sourceValue}\nTarget: ${tableName}[${orderColumn}] = ${targetValue}\n\nSQL to execute:\n${sql}`,
  },
  fkLookup: {
    loading: "Loading...",
    error: (detail) => `Error: ${detail}`,
    referenceUnavailable: "FK reference not available",
    searchPlaceholder: (table) => `Search ${table}...`,
    noMatches: "No matches",
    valueCount: (count) => `${count} values`,
  },
};

const COPY: Partial<Record<AppLanguage, DataGridCopy>> = {
  en: EN_COPY,
};

export function getDataGridCopy(language: AppLanguage): DataGridCopy {
  return COPY[language] ?? EN_COPY;
}
