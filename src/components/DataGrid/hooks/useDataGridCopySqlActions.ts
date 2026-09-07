import { useCallback } from "react";
import type { ConnectionConfig, QueryResult } from "../../../types";
import {
  copyToClipboard,
  generateDeleteSqlParameterized,
  generateInsertSqlParameterized,
  generateInsertSql,
  generateUpdateSqlParameterized,
  generateUpdateSql,
} from "../../../utils/sql-generator";
import type { ResolvedColumn } from "./useDataGrid";

interface DataGridCopySqlActionsParams {
  selectedRows: Set<number>;
  data: QueryResult | null;
  tableName?: string;
  resolvedColumns: ResolvedColumn[];
  primaryKeyColumns: ResolvedColumn[];
  connections: ConnectionConfig[];
  connectionId?: string;
  setError: (message: string) => void;
}

/**
 * Clipboard actions that emit SQL for the selected rows / current table.
 * Handlers are moved verbatim from the grid component body.
 */
export function useDataGridCopySqlActions({
  selectedRows,
  data,
  tableName,
  resolvedColumns,
  primaryKeyColumns,
  connections,
  connectionId,
  setError,
}: DataGridCopySqlActionsParams) {
  const handleCopyAsInsert = useCallback(async () => {
    if (selectedRows.size === 0 || !data || !tableName || resolvedColumns.length === 0) return;
    const connection = connections.find((c: ConnectionConfig) => c.id === connectionId);
    const dbType = connection?.db_type;
    const cols: string[] = resolvedColumns.map((c) => c.name);
    const rows = Array.from(selectedRows)
      .sort((a, b) => a - b)
      .map((i) => data.rows[i] as (string | number | boolean | null)[]);
    const sql = generateInsertSql(tableName, cols, rows, dbType);
    const ok = await copyToClipboard(sql);
    if (!ok) setError("Failed to copy SQL to clipboard.");
  }, [
    selectedRows,
    data,
    tableName,
    resolvedColumns,
    connections,
    connectionId,
    setError,
  ]);

  const handleCopyAsUpdate = useCallback(async () => {
    if (
      selectedRows.size === 0 ||
      !data ||
      !tableName ||
      resolvedColumns.length === 0 ||
      primaryKeyColumns.length === 0
    )
      return;
    const connection = connections.find((c: ConnectionConfig) => c.id === connectionId);
    const dbType = connection?.db_type;
    const cols: string[] = resolvedColumns.map((c) => c.name);
    const rows = Array.from(selectedRows)
      .sort((a, b) => a - b)
      .map((i) => data.rows[i] as (string | number | boolean | null)[]);
    const sql = generateUpdateSql(tableName, cols, rows, primaryKeyColumns.map((c) => c.name), dbType);
    const ok = await copyToClipboard(sql);
    if (!ok) setError("Failed to copy SQL to clipboard.");
  }, [
    selectedRows,
    data,
    tableName,
    resolvedColumns,
    primaryKeyColumns,
    connections,
    connectionId,
    setError,
  ]);

  const handleCopyAsInsertParam = useCallback(async () => {
    if (!tableName || resolvedColumns.length === 0) return;
    const connection = connections.find((c: ConnectionConfig) => c.id === connectionId);
    const dbType = connection?.db_type;
    const cols: string[] = resolvedColumns.map((c) => c.name);
    const sql = generateInsertSqlParameterized(tableName, cols, dbType);
    const ok = await copyToClipboard(sql);
    if (!ok) setError("Failed to copy SQL to clipboard.");
  }, [tableName, resolvedColumns, connections, connectionId, setError]);

  const handleCopyAsUpdateParam = useCallback(async () => {
    if (!tableName || resolvedColumns.length === 0 || primaryKeyColumns.length === 0) return;
    const connection = connections.find((c: ConnectionConfig) => c.id === connectionId);
    const dbType = connection?.db_type;
    const cols: string[] = resolvedColumns.map((c) => c.name);
    const sql = generateUpdateSqlParameterized(
      tableName,
      cols,
      primaryKeyColumns.map((c) => c.name),
      dbType,
    );
    const ok = await copyToClipboard(sql);
    if (!ok) setError("Failed to copy SQL to clipboard.");
  }, [tableName, resolvedColumns, primaryKeyColumns, connections, connectionId, setError]);

  const handleCopyAsDeleteParam = useCallback(async () => {
    if (!tableName || primaryKeyColumns.length === 0) return;
    const connection = connections.find((c: ConnectionConfig) => c.id === connectionId);
    const dbType = connection?.db_type;
    const sql = generateDeleteSqlParameterized(
      tableName,
      primaryKeyColumns.map((c) => c.name),
      dbType,
    );
    const ok = await copyToClipboard(sql);
    if (!ok) setError("Failed to copy SQL to clipboard.");
  }, [tableName, primaryKeyColumns, connections, connectionId, setError]);

  return {
    handleCopyAsInsert,
    handleCopyAsUpdate,
    handleCopyAsInsertParam,
    handleCopyAsUpdateParam,
    handleCopyAsDeleteParam,
  };
}
