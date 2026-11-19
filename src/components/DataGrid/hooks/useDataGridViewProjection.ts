import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDetail, ConnectionConfig, QueryResult, TableRowFocus } from "../../../types";
import { filterAndSortLocalRows, filterRowsWithSourceIndices } from "../local-result-operations";
import { buildRowFocusFilter } from "../row-focus";
import { buildStableRowIdentity } from "../row-identity";
import type { DataGridStoreApi } from "../store/dataGridStore";
import {
  buildResolvedColumns,
  resolveTableFilter,
  type GridCellValue,
  type ResolvedColumn,
  type StructureStatus,
} from "./useDataGrid";

export interface UseDataGridViewProjectionParams {
  connectionId: string;
  database?: string;
  tableName?: string;
  externalResult?: QueryResult;
  data: QueryResult | null;
  structureColumns: ColumnDetail[];
  structureStatus: StructureStatus;
  connections: ConnectionConfig[];
  tableFilter: string;
  sortColumn: string | null;
  sortDir: "ASC" | "DESC";
  rowFocus?: TableRowFocus;
  allowsInlineEdit: boolean;
  allowsAtomicEdits: boolean;
  dataGridStore: DataGridStoreApi;
  columnNamesRef: { current: string[] };
  rowSelectionAnchorRef: { current: string | null };
}

/**
 * Displayed-row projection (quick-filter + local sort + index mapping),
 * resolved column definitions, editability capability flags, and stable-identity
 * row selection synchronized into the per-instance `dataGridStore`.
 */
export function useDataGridViewProjection({
  connectionId,
  database,
  tableName,
  externalResult,
  data,
  structureColumns,
  structureStatus,
  connections,
  tableFilter,
  sortColumn,
  sortDir,
  rowFocus,
  allowsInlineEdit,
  allowsAtomicEdits,
  dataGridStore,
  columnNamesRef,
  rowSelectionAnchorRef,
}: UseDataGridViewProjectionParams) {
  const [selectedRowIdentities, setSelectedRowIdentities] = useState<Set<string>>(new Set());

  const rowFocusFilter = useMemo(() => buildRowFocusFilter(rowFocus), [rowFocus]);

  /** Resolved quick filter: server-side clause when expressible, else the
   *  client-side-only flag that limits filtering to loaded rows. */
  const filterPlan = useMemo(
    () =>
      resolveTableFilter(
        tableFilter,
        rowFocusFilter,
        structureColumns,
        connections.find((c) => c.id === connectionId)?.db_type,
      ),
    [tableFilter, rowFocusFilter, structureColumns, connections, connectionId],
  );

  // Displayed-row pipeline: quick filter (and for external results, client sort)
  // decides which rows exist for selection and range operations.
  const filteredTableRows = useMemo(() => {
    if (!data || externalResult) return [];
    return filterRowsWithSourceIndices(data.rows, tableFilter);
  }, [data, externalResult, tableFilter]);

  const filteredTableRowIndices = useMemo(
    () => filteredTableRows.map(({ sourceIndex }) => sourceIndex),
    [filteredTableRows],
  );

  const displayedRows = useMemo(() => {
    if (!data) return [];
    if (!externalResult) return filteredTableRows.map(({ row }) => row);
    return filterAndSortLocalRows(
      data.rows as GridCellValue[][],
      data.columns.map((column) => column.name),
      tableFilter,
      sortColumn,
      sortDir,
    );
  }, [data, externalResult, filteredTableRows, sortColumn, sortDir, tableFilter]);

  const displayedRowIndices = useMemo(() => {
    if (!externalResult) return filteredTableRowIndices;
    const sourceIndexByRow = new Map<GridCellValue[], number>();
    data?.rows.forEach((row, index) => {
      sourceIndexByRow.set(row as GridCellValue[], index);
    });
    return displayedRows.map((row, index) => sourceIndexByRow.get(row) ?? index);
  }, [data?.rows, displayedRows, externalResult, filteredTableRowIndices]);

  // Column resolution - must be derived before callbacks that depend on columns
  const dataColumns = data?.columns.length ? data.columns : structureColumns;

  const resolvedColumns = useMemo<ResolvedColumn[]>(() => {
    if (dataColumns.length === 0) return [];
    const cols = buildResolvedColumns(dataColumns, structureColumns);
    columnNamesRef.current = cols.map((c) => c.name);
    return cols;
  }, [columnNamesRef, dataColumns, structureColumns]);

  const primaryKeyColumns = useMemo(
    () => resolvedColumns.filter((column) => column.is_primary_key),
    [resolvedColumns],
  );

  const rowIdentities = useMemo(
    () => (data?.rows ?? []).map((row) => buildStableRowIdentity(row, resolvedColumns)),
    [data?.rows, resolvedColumns],
  );

  const selectedRows = useMemo(() => {
    const indices = new Set<number>();
    rowIdentities.forEach((identity, index) => {
      if (identity && selectedRowIdentities.has(identity)) indices.add(index);
    });
    return indices;
  }, [rowIdentities, selectedRowIdentities]);

  const setSelectedRows = useCallback(
    (update: Set<number> | ((previous: Set<number>) => Set<number>)) => {
      setSelectedRowIdentities((previousIdentities) => {
        const previousIndices = new Set<number>();
        rowIdentities.forEach((identity, index) => {
          if (identity && previousIdentities.has(identity)) previousIndices.add(index);
        });
        const nextIndices = typeof update === "function" ? update(previousIndices) : update;
        const nextIdentities = new Set<string>();
        nextIndices.forEach((index) => {
          const identity = rowIdentities[index];
          if (identity) nextIdentities.add(identity);
        });
        return nextIdentities;
      });
    },
    [rowIdentities],
  );

  useEffect(() => {
    if (!rowFocus || !data?.rows.length || externalResult) return;
    setSelectedRows(new Set([0]));
  }, [data, externalResult, rowFocus, setSelectedRows]);

  useEffect(() => {
    setSelectedRowIdentities(new Set());
    rowSelectionAnchorRef.current = null;
  }, [connectionId, database, externalResult, rowSelectionAnchorRef, tableName]);

  const isTableEditable = Boolean(
    tableName &&
    !externalResult &&
    allowsInlineEdit &&
    allowsAtomicEdits &&
    structureStatus === "ready" &&
    primaryKeyColumns.length > 0,
  );
  const canAttemptInlineEdit = Boolean(
    tableName && !externalResult && allowsInlineEdit && allowsAtomicEdits,
  );
  const canSelectRows = Boolean(tableName && !externalResult && primaryKeyColumns.length > 0);
  const selectedRowCount = selectedRows.size;
  const allVisibleRowsSelected = Boolean(
    canSelectRows &&
    filteredTableRowIndices.length &&
    filteredTableRowIndices.every((rowIndex) => selectedRows.has(rowIndex)),
  );

  useEffect(() => {
    dataGridStore.getState().syncRowSelection(selectedRows, allVisibleRowsSelected);
  }, [allVisibleRowsSelected, dataGridStore, selectedRows]);

  const tableData = useMemo(() => displayedRows, [displayedRows]);
  const isPageClamped = Boolean(!externalResult && data?.truncated);

  return {
    rowFocusFilter,
    filterPlan,
    filteredTableRowIndices,
    displayedRows,
    displayedRowIndices,
    resolvedColumns,
    primaryKeyColumns,
    rowIdentities,
    selectedRows,
    setSelectedRows,
    isTableEditable,
    canAttemptInlineEdit,
    canSelectRows,
    selectedRowCount,
    allVisibleRowsSelected,
    tableData,
    isPageClamped,
  };
}
