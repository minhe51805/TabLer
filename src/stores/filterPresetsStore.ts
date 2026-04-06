import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  FilterPreset,
  FilterCondition,
  FilterOperator,
  ColumnFilter,
} from "../types/filter-presets";

const STORAGE_KEY = "tabler.filter-presets";

interface FilterPresetsState {
  presets: FilterPreset[];
  activePresetId: string | null;
}

interface FilterPresetsActions {
  savePreset: (preset: Omit<FilterPreset, "id">) => FilterPreset;
  updatePreset: (id: string, updates: Partial<FilterPreset>) => void;
  deletePreset: (id: string) => void;
  getPreset: (id: string) => FilterPreset | undefined;
  setActivePreset: (id: string | null) => void;
  getActivePreset: () => FilterPreset | undefined;
  /** Export all presets as JSON string */
  exportPresets: () => string;
  /** Import presets from JSON string, returns number of imported */
  importPresets: (json: string) => number;
}

export type FilterPresetsStore = FilterPresetsState & FilterPresetsActions;

const useFilterPresetsBase = create<FilterPresetsStore>()(
  persist(
    (set, get) => ({
      presets: [],
      activePresetId: null,

      savePreset: (preset) => {
        const newPreset: FilterPreset = {
          ...preset,
          id: crypto.randomUUID(),
        };
        set((state) => ({
          presets: [...state.presets, newPreset],
          activePresetId: newPreset.id,
        }));
        return newPreset;
      },

      updatePreset: (id, updates) => {
        set((state) => ({
          presets: state.presets.map((p) =>
            p.id === id ? { ...p, ...updates } : p
          ),
        }));
      },

      deletePreset: (id) => {
        set((state) => ({
          presets: state.presets.filter((p) => p.id !== id),
          activePresetId: state.activePresetId === id ? null : state.activePresetId,
        }));
      },

      getPreset: (id) => {
        return get().presets.find((p) => p.id === id);
      },

      setActivePreset: (id) => {
        set({ activePresetId: id });
      },

      getActivePreset: () => {
        const { presets, activePresetId } = get();
        if (!activePresetId) return undefined;
        return presets.find((p) => p.id === activePresetId);
      },

      exportPresets: () => {
        const { presets } = get();
        const exportData = presets.map(({ name, tableFilter, schemaFilter, objectTypes, tags, columnFilter, conditions, conditionLogic, columnMode, tableOperator, schemaOperator }) => ({
          name,
          tableFilter,
          schemaFilter,
          objectTypes,
          tags,
          columnFilter,
          conditions,
          conditionLogic,
          columnMode,
          tableOperator,
          schemaOperator,
        }));
        return JSON.stringify(exportData, null, 2);
      },

      importPresets: (json) => {
        try {
          const imported = JSON.parse(json);
          if (!Array.isArray(imported)) return 0;
          let count = 0;
          for (const item of imported) {
            if (item.name && Array.isArray(item.conditions)) {
              get().savePreset({
                name: item.name,
                tableFilter: item.tableFilter ?? "",
                schemaFilter: item.schemaFilter ?? "",
                objectTypes: item.objectTypes ?? [],
                tags: item.tags ?? [],
                columnFilter: item.columnFilter,
                conditions: item.conditions.map((c: FilterCondition) => ({
                  ...c,
                  id: crypto.randomUUID(),
                })),
                conditionLogic: item.conditionLogic ?? "AND",
                columnMode: item.columnMode ?? false,
                tableOperator: item.tableOperator ?? "contains",
                schemaOperator: item.schemaOperator ?? "contains",
              });
              count++;
            }
          }
          return count;
        } catch {
          return 0;
        }
      },
    }),
    {
      name: STORAGE_KEY,
      // Only persist presets, not the active preset ID (transient)
      partialize: (state) => ({
        presets: state.presets,
        activePresetId: null,
      }),
    }
  )
);

// Re-export types for convenience
export type { FilterPreset, FilterCondition, FilterOperator, ColumnFilter };
export { FILTER_OPERATOR_LABELS, FILTER_OPERATOR_CATEGORIES, DEFAULT_FILTER_OPERATOR } from "../types/filter-presets";

// Named export to match existing store patterns
export const useFilterPresetsStore = useFilterPresetsBase;
