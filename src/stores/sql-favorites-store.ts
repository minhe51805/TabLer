import { create } from "zustand";
import { invokeMutation } from "../utils/tauri-utils";
import type { SqlFavorite } from "../types/query-history";

interface SqlFavoritesState {
  favorites: SqlFavorite[];
  isLoading: boolean;
  isSaving: boolean;

  loadFavorites: () => Promise<void>;
  saveFavorite: (params: {
    id?: string;
    name: string;
    description?: string;
    sql: string;
    tags?: string[];
  }) => Promise<SqlFavorite>;
  deleteFavorite: (id: string) => Promise<void>;
}

export const useSqlFavoritesStore = create<SqlFavoritesState>((set) => ({
  favorites: [],
  isLoading: false,
  isSaving: false,

  loadFavorites: async () => {
    set({ isLoading: true });
    try {
      const favorites = await invokeMutation<SqlFavorite[]>("get_sql_favorites", {});
      set({ favorites, isLoading: false });
    } catch (e) {
      console.error("Failed to load SQL favorites:", e);
      set({ isLoading: false });
    }
  },

  saveFavorite: async ({ id, name, description, sql, tags }) => {
    set({ isSaving: true });
    try {
      const saved = await invokeMutation<SqlFavorite>("save_sql_favorite", {
        id: id ?? null,
        name,
        description: description ?? null,
        sql,
        tags: tags ?? null,
      });
      set((state) => {
        const exists = state.favorites.some((f) => f.id === saved.id);
        if (exists) {
          return {
            favorites: state.favorites.map((f) => (f.id === saved.id ? saved : f)),
            isSaving: false,
          };
        }
        return {
          favorites: [saved, ...state.favorites],
          isSaving: false,
        };
      });
      return saved;
    } catch (e) {
      console.error("Failed to save SQL favorite:", e);
      set({ isSaving: false });
      throw e;
    }
  },

  deleteFavorite: async (id) => {
    try {
      await invokeMutation<void>("delete_sql_favorite", { id });
      set((state) => ({
        favorites: state.favorites.filter((f) => f.id !== id),
      }));
    } catch (e) {
      console.error("Failed to delete SQL favorite:", e);
      throw e;
    }
  },
}));
