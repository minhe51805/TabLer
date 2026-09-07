import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { MixedStateFilter, CheckboxFilterState } from "./use-sidebar";

const EMPTY_MIXED_FILTER: MixedStateFilter = {
  checkedItems: {},
  uncheckedItems: {},
  isActive: false,
};
import {
  DEFAULT_FILTER_OPERATOR,
  type FilterOperator,
  type FilterCondition,
  type ColumnFilter,
} from "../../../types/filter-presets";
import type { FilterPresetsStore } from "../../../stores/filterPresetsStore";


interface UseTableFilterActionsParams {
  // Presets
  presetNameInput: string;
  search: string;
  activeSchemaFilter: string;
  columnModeActive: boolean;
  columnPattern: string;
  columnOperator: ColumnFilter["operator"];
  conditions: FilterCondition[];
  conditionLogic: "AND" | "OR";
  tableOperator: FilterOperator;
  schemaOperator: FilterOperator;
  presetsStore: FilterPresetsStore;
  setSearch: Dispatch<SetStateAction<string>>;
  setActiveSchemaFilter: Dispatch<SetStateAction<string>>;
  setTableOperator: Dispatch<SetStateAction<FilterOperator>>;
  setSchemaOperator: Dispatch<SetStateAction<FilterOperator>>;
  setColumnModeActive: Dispatch<SetStateAction<boolean>>;
  setColumnPattern: Dispatch<SetStateAction<string>>;
  setColumnOperator: Dispatch<SetStateAction<ColumnFilter["operator"]>>;
  setConditions: Dispatch<SetStateAction<FilterCondition[]>>;
  setConditionLogic: Dispatch<SetStateAction<"AND" | "OR">>;
  setSavePresetDialogOpen: Dispatch<SetStateAction<boolean>>;
  setPresetNameInput: Dispatch<SetStateAction<string>>;
  setFilterPresetMenuOpen: Dispatch<SetStateAction<boolean>>;
  // Mixed-state filter
  mixedStateFilter: MixedStateFilter;
  setMixedStateFilter: Dispatch<SetStateAction<MixedStateFilter>>;
  mixedFilterRef: RefObject<MixedStateFilter>;
  tableFilterStateRef: RefObject<Record<string, MixedStateFilter>>;
}

/**
 * Filter-preset persistence plus per-table mixed-state include/exclude toggles.
 * Handlers are moved verbatim from use-sidebar.
 */
export function useTableFilterActions({
  presetNameInput,
  search,
  activeSchemaFilter,
  columnModeActive,
  columnPattern,
  columnOperator,
  conditions,
  conditionLogic,
  tableOperator,
  schemaOperator,
  presetsStore,
  setSearch,
  setActiveSchemaFilter,
  setTableOperator,
  setSchemaOperator,
  setColumnModeActive,
  setColumnPattern,
  setColumnOperator,
  setConditions,
  setConditionLogic,
  setSavePresetDialogOpen,
  setPresetNameInput,
  setFilterPresetMenuOpen,
  mixedStateFilter,
  setMixedStateFilter,
  mixedFilterRef,
  tableFilterStateRef,
}: UseTableFilterActionsParams) {
  const handleSavePreset = useCallback(() => {
    const name = presetNameInput.trim();
    if (!name) return;
    presetsStore.savePreset({
      name,
      tableFilter: search,
      schemaFilter: activeSchemaFilter,
      objectTypes: [],
      tags: [],
      columnFilter: columnModeActive
        ? { pattern: columnPattern, operator: columnOperator }
        : undefined,
      conditions,
      conditionLogic,
      columnMode: columnModeActive,
      tableOperator,
      schemaOperator,
    });
    setSavePresetDialogOpen(false);
    setPresetNameInput("");
  }, [
    presetNameInput, search, activeSchemaFilter, columnModeActive,
    columnPattern, columnOperator, conditions, conditionLogic,
    tableOperator, schemaOperator, presetsStore,
  ]);

  const handleLoadPreset = useCallback((presetId: string) => {
    const preset = presetsStore.getPreset(presetId);
    if (!preset) return;
    setSearch(preset.tableFilter);
    setActiveSchemaFilter(preset.schemaFilter);
    setTableOperator(preset.tableOperator ?? DEFAULT_FILTER_OPERATOR);
    setSchemaOperator(preset.schemaOperator ?? DEFAULT_FILTER_OPERATOR);
    setColumnModeActive(preset.columnMode ?? false);
    if (preset.columnFilter) {
      setColumnPattern(preset.columnFilter.pattern);
      setColumnOperator(preset.columnFilter.operator);
    }
    setConditions(preset.conditions ?? []);
    setConditionLogic(preset.conditionLogic ?? "AND");
    presetsStore.setActivePreset(presetId);
    setFilterPresetMenuOpen(false);
  }, [presetsStore]);

  const handleDeletePreset = useCallback((presetId: string) => {
    if (!window.confirm("Delete this filter preset?")) return;
    presetsStore.deletePreset(presetId);
  }, [presetsStore]);

  const handleClearFilters = useCallback(() => {
    setSearch("");
    setActiveSchemaFilter("all");
    setTableOperator(DEFAULT_FILTER_OPERATOR);
    setSchemaOperator(DEFAULT_FILTER_OPERATOR);
    setColumnModeActive(false);
    setColumnPattern("");
    setConditions([]);
    setConditionLogic("AND");
    setMixedStateFilter(EMPTY_MIXED_FILTER);
    mixedFilterRef.current = EMPTY_MIXED_FILTER;
    tableFilterStateRef.current = {};
  }, []);

  const handleMixedStateToggle = useCallback((
    schemaName: string,
    itemName: string,
    newState: CheckboxFilterState,
  ) => {
    setMixedStateFilter((prev) => {
      const next: MixedStateFilter = {
        checkedItems: { ...prev.checkedItems },
        uncheckedItems: { ...prev.uncheckedItems },
        isActive: true,
      };
      const schemaChecked = new Set(prev.checkedItems[schemaName] ?? []);
      const schemaUnchecked = new Set(prev.uncheckedItems[schemaName] ?? []);

      if (newState === "indeterminate") {
        schemaChecked.delete(itemName);
        schemaUnchecked.delete(itemName);
      } else if (newState === "checked") {
        schemaChecked.add(itemName);
        schemaUnchecked.delete(itemName);
      } else {
        schemaChecked.delete(itemName);
        schemaUnchecked.add(itemName);
      }

      if (schemaChecked.size > 0) {
        next.checkedItems[schemaName] = schemaChecked;
      }
      if (schemaUnchecked.size > 0) {
        next.uncheckedItems[schemaName] = schemaUnchecked;
      }

      // If nothing is filtered, deactivate
      const hasAnyFilter =
        Object.values(next.checkedItems).some((s) => s.size > 0) ||
        Object.values(next.uncheckedItems).some((s) => s.size > 0);
      next.isActive = hasAnyFilter;

      return next;
    });
    mixedFilterRef.current = {
      ...mixedStateFilter,
      isActive: true,
    };
  }, [mixedStateFilter]);

  const getMixedStateFilterForTable = useCallback((tableName: string, schemaName: string) => {
    const key = `${schemaName}|${tableName}`;
    return tableFilterStateRef.current[key] ?? mixedFilterRef.current;
  }, []);

  const persistMixedStateForTable = useCallback((
    tableName: string,
    schemaName: string,
    filter: MixedStateFilter,
  ) => {
    const key = `${schemaName}|${tableName}`;
    tableFilterStateRef.current[key] = filter;
  }, []);

  return {
    handleSavePreset,
    handleLoadPreset,
    handleDeletePreset,
    handleClearFilters,
    handleMixedStateToggle,
    getMixedStateFilterForTable,
    persistMixedStateForTable,
  };
}
