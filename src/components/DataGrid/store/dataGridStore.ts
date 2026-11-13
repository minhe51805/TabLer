import { createContext, createElement, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { createEmptyGridSelection, type GridSelectionState } from "../grid-selection";
import type { EditingCell } from "../hooks/useDataGrid";

const EMPTY_SELECTED_ROWS = new Set<number>();

export interface DataGridStoreState {
  gridSelection: GridSelectionState;
  editingCell: EditingCell | null;
  editingSeedValue: string;
  savingCell: EditingCell | null;
  copiedCell: string | null;
  selectedRows: Set<number>;
  allVisibleRowsSelected: boolean;
  setGridSelection: (
    next: GridSelectionState | ((prev: GridSelectionState) => GridSelectionState),
  ) => void;
  setEditingCell: (
    next: EditingCell | null | ((prev: EditingCell | null) => EditingCell | null),
  ) => void;
  setEditingSeedValue: (next: string | ((prev: string) => string)) => void;
  setSavingCell: (
    next: EditingCell | null | ((prev: EditingCell | null) => EditingCell | null),
  ) => void;
  setCopiedCell: (next: string | null | ((prev: string | null) => string | null)) => void;
  syncRowSelection: (selectedRows: Set<number>, allVisibleRowsSelected: boolean) => void;
}

export type DataGridStoreApi = StoreApi<DataGridStoreState>;

function resolveUpdate<T>(next: T | ((prev: T) => T), prev: T): T {
  return typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
}

/**
 * Per-instance UI interaction store for `<DataGrid />`.
 * Each mounted grid creates its own store via `createDataGridStore` and
 * exposes it via `DataGridStoreProvider` so multi-tab / multi-pane grids
 * remain completely isolated.
 */
export function createDataGridStore(): DataGridStoreApi {
  return createStore<DataGridStoreState>((set) => ({
    gridSelection: createEmptyGridSelection(),
    editingCell: null,
    editingSeedValue: "",
    savingCell: null,
    copiedCell: null,
    selectedRows: EMPTY_SELECTED_ROWS,
    allVisibleRowsSelected: false,
    setGridSelection: (next) =>
      set((state) => {
        const resolved = resolveUpdate(next, state.gridSelection);
        return resolved === state.gridSelection ? state : { gridSelection: resolved };
      }),
    setEditingCell: (next) =>
      set((state) => {
        const resolved = resolveUpdate(next, state.editingCell);
        return resolved === state.editingCell ? state : { editingCell: resolved };
      }),
    setEditingSeedValue: (next) =>
      set((state) => {
        const resolved = resolveUpdate(next, state.editingSeedValue);
        return resolved === state.editingSeedValue ? state : { editingSeedValue: resolved };
      }),
    setSavingCell: (next) =>
      set((state) => {
        const resolved = resolveUpdate(next, state.savingCell);
        return resolved === state.savingCell ? state : { savingCell: resolved };
      }),
    setCopiedCell: (next) =>
      set((state) => {
        const resolved = resolveUpdate(next, state.copiedCell);
        return resolved === state.copiedCell ? state : { copiedCell: resolved };
      }),
    syncRowSelection: (selectedRows, allVisibleRowsSelected) =>
      set((state) => {
        if (
          state.allVisibleRowsSelected === allVisibleRowsSelected &&
          state.selectedRows.size === selectedRows.size
        ) {
          let same = true;
          for (const id of state.selectedRows) {
            if (!selectedRows.has(id)) {
              same = false;
              break;
            }
          }
          if (same) return state;
        }
        return { selectedRows, allVisibleRowsSelected };
      }),
  }));
}

export const DataGridStoreContext = createContext<DataGridStoreApi | null>(null);

const FALLBACK_GRID_STORE = createDataGridStore();

export function DataGridStoreProvider({
  store,
  children,
}: {
  store: DataGridStoreApi;
  children: ReactNode;
}) {
  return createElement(DataGridStoreContext.Provider, { value: store }, children);
}

export function useDataGridStoreApi(): DataGridStoreApi {
  const store = useContext(DataGridStoreContext);
  if (!store) {
    throw new Error("useDataGridStore must be used inside a DataGridStoreProvider");
  }
  return store;
}

export function useDataGridStore<T>(selector: (state: DataGridStoreState) => T): T {
  const store = useDataGridStoreApi();
  return useStore(store, selector);
}

/**
 * Reads from the enclosing `DataGridStoreProvider` when mounted; otherwise
 * subscribes to an inert fallback store and returns `fallback` so standalone
 * tests calling `buildDataGridColumns` without a provider keep working.
 */
export function useOptionalDataGridStore<T>(
  selector: (state: DataGridStoreState) => T,
  fallback: T,
): T {
  const store = useContext(DataGridStoreContext);
  const selected = useStore(store ?? FALLBACK_GRID_STORE, selector);
  return store ? selected : fallback;
}
