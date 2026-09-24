import { useCallback, useEffect, useMemo, useState } from "react";
import {
  anonymizeRows,
  anonymizeValue,
  type AnonymizerStrategy,
  type AnonymizerValue,
} from "../../../utils/anonymizer";
import { columnMaskScopeKey, useColumnMaskStore } from "../../../stores/columnMaskStore";
import type { GridCellValue, ResolvedColumn } from "./useDataGrid";

export interface DataGridColumnMasks {
  /** Scope key (`connectionId|database|table`) — "" for query-result grids. */
  scopeKey: string;
  /** Every column with a mask rule, revealed or not (drives the header badge). */
  maskedColumnNames: ReadonlySet<string>;
  /** Columns currently rendering masked (rule set AND not revealed). */
  activeMaskedNames: ReadonlySet<string>;
  /** Deterministic per-scope salt; undefined until the first mask is set. */
  salt: string | undefined;
  /**
   * Masked copy of `displayedRows`, same row order/indices — or null while
   * the async anonymizer is still computing (or no mask is active). Only
   * ever exposed when it was computed from the CURRENT displayedRows array,
   * so a stale matrix can never be rendered against new rows.
   */
  maskedRows: GridCellValue[][] | null;
  /** True when at least one column is actively masked (not revealed). */
  hasActiveMasks: boolean;
  /** Session-only reveal toggle. */
  toggleRevealed: (column: string) => void;
  /** Mask one value on demand (context-menu cell copy). */
  maskValue: (column: string, value: AnonymizerValue) => Promise<AnonymizerValue>;
  /** Mask a row matrix on demand (context-menu/SQL/range copies). */
  maskRows: (rows: readonly (readonly AnonymizerValue[])[]) => Promise<AnonymizerValue[][]>;
  /** Column name → strategy for every masked column (revealed or not). */
  maskStrategies: Record<string, AnonymizerStrategy>;
}

/**
 * View-time masking pipeline for the DataGrid.
 *
 * Mask rules live in `columnMaskStore` (persisted per connection+table);
 * the per-session reveal set never persists. Masked output is precomputed
 * asynchronously over the displayed row window so the synchronous cell
 * renderer stays cheap — cells show a placeholder until the matrix lands.
 */
export function useDataGridColumnMasks(
  connectionId: string,
  database: string | undefined,
  tableName: string | undefined,
  resolvedColumns: ResolvedColumn[],
  displayedRows: GridCellValue[][],
): DataGridColumnMasks {
  const scopeKey = tableName ? columnMaskScopeKey(connectionId, database, tableName) : "";
  const scopeMasks = useColumnMaskStore((state) => (scopeKey ? state.masks[scopeKey] : undefined));
  const salt = useColumnMaskStore((state) => (scopeKey ? state.salts[scopeKey] : undefined));
  const revealedList = useColumnMaskStore((state) =>
    scopeKey ? state.revealed[scopeKey] : undefined,
  );
  const setRevealed = useColumnMaskStore((state) => state.setRevealed);
  const ensureSalt = useColumnMaskStore((state) => state.ensureSalt);

  const maskedColumnNames = useMemo(() => new Set(Object.keys(scopeMasks ?? {})), [scopeMasks]);
  const revealedSet = useMemo(() => new Set(revealedList ?? []), [revealedList]);
  const activeMaskedNames = useMemo(() => {
    const active = new Set<string>();
    for (const name of maskedColumnNames) {
      if (!revealedSet.has(name)) active.add(name);
    }
    return active;
  }, [maskedColumnNames, revealedSet]);

  /** column index → strategy for actively masked columns. */
  const activeStrategies = useMemo(() => {
    const strategies = new Map<number, AnonymizerStrategy>();
    if (!scopeMasks) return strategies;
    resolvedColumns.forEach((column, index) => {
      const strategy = scopeMasks[column.name];
      if (strategy && !revealedSet.has(column.name)) strategies.set(index, strategy);
    });
    return strategies;
  }, [resolvedColumns, scopeMasks, revealedSet]);

  const hasActiveMasks = activeStrategies.size > 0;

  // Precompute the masked matrix. `source` pins the input array identity so
  // a result computed for a previous displayedRows is never exposed.
  const [masked, setMasked] = useState<{
    source: GridCellValue[][];
    rows: GridCellValue[][];
  } | null>(null);

  useEffect(() => {
    if (!hasActiveMasks) {
      setMasked(null);
      return;
    }
    // Masks restored from storage without a salt (partial write) get one
    // lazily — the effect re-runs once the store update lands.
    if (!salt) {
      if (scopeKey) ensureSalt(scopeKey);
      return;
    }
    let cancelled = false;
    const source = displayedRows;
    void anonymizeRows(source, activeStrategies, salt).then((rows) => {
      if (!cancelled) setMasked({ source, rows: rows as GridCellValue[][] });
    });
    return () => {
      cancelled = true;
    };
  }, [displayedRows, activeStrategies, salt, hasActiveMasks, scopeKey, ensureSalt]);

  const maskedRows = masked && masked.source === displayedRows ? masked.rows : null;

  const toggleRevealed = useCallback(
    (column: string) => {
      if (scopeKey) setRevealed(scopeKey, column, !revealedSet.has(column));
    },
    [scopeKey, setRevealed, revealedSet],
  );

  const maskValue = useCallback(
    async (column: string, value: AnonymizerValue) => {
      const strategy = scopeMasks?.[column];
      if (!strategy || revealedSet.has(column) || !salt) return value;
      return anonymizeValue(value, strategy, salt);
    },
    [scopeMasks, revealedSet, salt],
  );

  const maskRows = useCallback(
    (rows: readonly (readonly AnonymizerValue[])[]) =>
      hasActiveMasks && salt
        ? anonymizeRows(rows, activeStrategies, salt)
        : Promise.resolve(rows.map((row) => [...row])),
    [hasActiveMasks, salt, activeStrategies],
  );

  return {
    scopeKey,
    maskedColumnNames,
    activeMaskedNames,
    maskStrategies: scopeMasks ?? {},
    salt,
    maskedRows,
    hasActiveMasks,
    toggleRevealed,
    maskValue,
    maskRows,
  };
}
