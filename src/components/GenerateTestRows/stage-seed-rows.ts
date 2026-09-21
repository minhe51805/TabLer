/**
 * Staging bridge for generated test rows: pushes them into the change-tracking
 * queue as one undo unit and opens the review modal. Kept store-only (no
 * Tauri/React imports) so it stays unit-testable.
 */

import { useChangeTrackingStore } from "../../stores/change-tracking-store";
import type { ColumnDetail } from "../../types";
import type { DatabaseType } from "../../types/database";
import type { StagedChange } from "../../types/change-tracking";
import type { GeneratedRow } from "../../utils/test-row-generator";

/**
 * The store resolves index-keyed columns through `_columnNameMap[tableName]` —
 * registered by the grid's structure fetch — so we invert that map by name.
 * When no grid has registered one yet we register a map built from the given
 * column order (the same order the grid's fetcher would use), then stage every
 * row as an insert and open the review modal. Returns the staged row count.
 */
export function stageGeneratedRows(options: {
  tableName: string;
  database?: string;
  dbType?: DatabaseType;
  columns: readonly ColumnDetail[];
  rows: readonly GeneratedRow[];
}): number {
  const { tableName, database, dbType, columns, rows } = options;
  const store = useChangeTrackingStore.getState();

  let nameMap = store._columnNameMap[tableName];
  if (!nameMap || Object.keys(nameMap).length === 0) {
    nameMap = {};
    columns.forEach((column, index) => {
      nameMap![index] = column.name;
    });
    store.setColumnNameMap(tableName, nameMap);
  }
  if (dbType) store.setDbType(tableName, dbType);

  const indexByName = new Map<string, number>();
  for (const [index, name] of Object.entries(nameMap)) {
    indexByName.set(name, Number(index));
  }
  const mapSize = Object.keys(nameMap).length;

  const changes: Array<Omit<StagedChange, "id" | "timestamp" | "sqlPreview">> = [];
  for (const row of rows) {
    const changeColumns: Record<string, { old: unknown; new: unknown }> = {};
    const originalRow: (string | number | boolean | null)[] = new Array(mapSize).fill(null);
    for (const [name, value] of Object.entries(row)) {
      const index = indexByName.get(name);
      if (index === undefined) continue;
      changeColumns[index] = { old: null, new: value };
      originalRow[index] = value;
    }
    if (Object.keys(changeColumns).length === 0) continue;
    changes.push({
      type: "insert",
      tableName,
      database,
      // No source row exists — inserts have no grid row to highlight.
      rowIndex: -1,
      rowKey: {},
      columns: changeColumns,
      originalRow,
    });
  }

  if (changes.length > 0) {
    store.stageChanges(changes);
    store.openPreview();
  }
  return changes.length;
}
