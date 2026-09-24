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
    /** Pill shown while the grid renders a cached page instead of fresh data. */
    cached: string;
    cachedTitle: string;
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
  /** Inline cell editors: explicit NULL gesture + editor hints. */
  editor: {
    setNull: string;
    setNullTitle: string;
    textPlaceholder: string;
    jsonCommitHint: string;
    jsonInvalid: string;
    hexInvalidChars: string;
    hexOddDigits: string;
    hexTooLarge: (maxBytes: number) => string;
  };
  /** parseEditorValue validation failures, surfaced via the grid error banner. */
  validation: {
    boolean: string;
    numeric: string;
    json: string;
    hex: string;
  };
  /** Staged-change queue errors. */
  stagedChanges: {
    deleteNotCommittable: string;
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
    cached: "Cached",
    cachedTitle:
      "Showing a cached page (up to 2 minutes old). Use the reload button for fresh data.",
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
  editor: {
    setNull: "NULL",
    setNullTitle: "Set this cell to NULL",
    textPlaceholder: "Type a value",
    jsonCommitHint: "Press Ctrl+Enter to commit",
    jsonInvalid: "Invalid JSON",
    hexInvalidChars: "Invalid hex: use only 0-9, a-f",
    hexOddDigits: "Hex must have an even number of digits",
    hexTooLarge: (maxBytes) => `Max ${Math.round(maxBytes / 1024)} KB (${maxBytes * 2} hex chars)`,
  },
  validation: {
    boolean: "Boolean values must be true or false.",
    numeric: "Numeric columns only accept valid numbers.",
    json: "Invalid JSON format.",
    hex: "Invalid hex format. Use space-separated bytes (e.g. '48 65 6c 6c 6f').",
  },
  stagedChanges: {
    deleteNotCommittable:
      "The queue contains a staged row deletion, which cannot be committed through the atomic apply path. Discard it and delete the row directly instead.",
  },
};

const COPY: Partial<Record<AppLanguage, DataGridCopy>> = {
  en: EN_COPY,
};

export function getDataGridCopy(language: AppLanguage): DataGridCopy {
  return COPY[language] ?? EN_COPY;
}
