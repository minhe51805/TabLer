import type { QueryResult } from "../../types";
import { areCellValuesEqual } from "../DataGrid/hooks/useDataGrid";

export type ResultCellValue = string | number | boolean | null;

/** One differing cell inside a changed row. */
export interface DiffCellChange {
  column: string;
  before: ResultCellValue;
  after: ResultCellValue;
}

/** A row present on only one side; `values` is aligned to `ResultDiff.columns`. */
export interface DiffSideRow {
  key: string;
  values: ResultCellValue[];
}

/** A row present on both sides with at least one differing shared column. */
export interface DiffChangedRow {
  key: string;
  cells: DiffCellChange[];
}

export interface ResultDiff {
  /** How rows were paired across the two results. */
  mode: "primary-key" | "row-index";
  /** PK column names used for matching (empty in row-index mode). */
  keyColumns: string[];
  /** Display column order: A's columns first, then B-only columns. */
  columns: string[];
  added: DiffSideRow[];
  removed: DiffSideRow[];
  changed: DiffChangedRow[];
  unchangedCount: number;
  columnsOnlyInA: string[];
  columnsOnlyInB: string[];
}

/**
 * Compares two query results. Rows are matched by primary-key column values
 * when both results flag the same non-empty PK set (and keys are unique on
 * both sides); otherwise rows are paired by position. Only columns present in
 * both results participate in cell comparison — side-only columns are
 * reported separately.
 */
export function computeResultDiff(a: QueryResult, b: QueryResult): ResultDiff {
  const colsA = a.columns.map((column) => column.name);
  const colsB = b.columns.map((column) => column.name);
  const setA = new Set(colsA);
  const setB = new Set(colsB);
  const columns = [...colsA, ...colsB.filter((name) => !setA.has(name))];
  const columnsOnlyInA = colsA.filter((name) => !setB.has(name));
  const columnsOnlyInB = colsB.filter((name) => !setA.has(name));
  const shared = colsA.filter((name) => setB.has(name));

  const indexA = new Map(colsA.map((name, index) => [name, index]));
  const indexB = new Map(colsB.map((name, index) => [name, index]));

  const pkA = a.columns.filter((column) => column.is_primary_key).map((column) => column.name);
  const pkB = b.columns.filter((column) => column.is_primary_key).map((column) => column.name);
  const samePkSet =
    pkA.length > 0 && pkA.length === pkB.length && pkA.every((name) => pkB.includes(name));

  const alignRow = (row: ResultCellValue[], indexMap: Map<string, number>): ResultCellValue[] =>
    columns.map((name) => row[indexMap.get(name) ?? -1] ?? null);

  const diff: ResultDiff = {
    mode: "row-index",
    keyColumns: [],
    columns,
    added: [],
    removed: [],
    changed: [],
    unchangedCount: 0,
    columnsOnlyInA,
    columnsOnlyInB,
  };

  const comparePair = (key: string, rowA: ResultCellValue[], rowB: ResultCellValue[]) => {
    const cells: DiffCellChange[] = [];
    for (const name of shared) {
      const before = rowA[indexA.get(name)!] ?? null;
      const after = rowB[indexB.get(name)!] ?? null;
      if (!areCellValuesEqual(before, after)) {
        cells.push({ column: name, before, after });
      }
    }
    if (cells.length > 0) {
      diff.changed.push({ key, cells });
    } else {
      diff.unchangedCount += 1;
    }
  };

  if (samePkSet) {
    const keyOf = (row: ResultCellValue[], indexMap: Map<string, number>) =>
      pkA.map((name) => JSON.stringify(row[indexMap.get(name)!] ?? null)).join("");
    const labelOf = (row: ResultCellValue[], indexMap: Map<string, number>) =>
      pkA.map((name) => `${name}=${String(row[indexMap.get(name)!] ?? "NULL")}`).join(", ");

    const mapA = new Map<string, number>();
    let unique = true;
    a.rows.forEach((row, rowIndex) => {
      const key = keyOf(row, indexA);
      if (mapA.has(key)) unique = false;
      mapA.set(key, rowIndex);
    });
    const seenB = new Set<string>();
    if (unique) {
      b.rows.forEach((row) => {
        const key = keyOf(row, indexB);
        if (seenB.has(key)) unique = false;
        seenB.add(key);
      });
    }

    if (unique) {
      diff.mode = "primary-key";
      diff.keyColumns = pkA;
      const matchedA = new Set<number>();
      b.rows.forEach((rowB) => {
        const key = keyOf(rowB, indexB);
        const aIndex = mapA.get(key);
        if (aIndex === undefined) {
          diff.added.push({ key: labelOf(rowB, indexB), values: alignRow(rowB, indexB) });
          return;
        }
        matchedA.add(aIndex);
        comparePair(labelOf(rowB, indexB), a.rows[aIndex], rowB);
      });
      a.rows.forEach((rowA, rowIndex) => {
        if (!matchedA.has(rowIndex)) {
          diff.removed.push({ key: labelOf(rowA, indexA), values: alignRow(rowA, indexA) });
        }
      });
      return diff;
    }
    // Duplicate keys make PK matching ambiguous — fall through to row index.
  }

  const paired = Math.min(a.rows.length, b.rows.length);
  for (let rowIndex = 0; rowIndex < paired; rowIndex += 1) {
    comparePair(`#${rowIndex + 1}`, a.rows[rowIndex], b.rows[rowIndex]);
  }
  for (let rowIndex = paired; rowIndex < b.rows.length; rowIndex += 1) {
    diff.added.push({
      key: `#${rowIndex + 1}`,
      values: alignRow(b.rows[rowIndex], indexB),
    });
  }
  for (let rowIndex = paired; rowIndex < a.rows.length; rowIndex += 1) {
    diff.removed.push({
      key: `#${rowIndex + 1}`,
      values: alignRow(a.rows[rowIndex], indexA),
    });
  }
  return diff;
}
