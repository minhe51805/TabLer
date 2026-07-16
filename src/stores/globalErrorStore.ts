import { create } from "zustand";

interface GlobalErrorState {
  error: string | null;
  setError: (error: string | null) => void;
  clearError: () => void;
}

export const useGlobalErrorStore = create<GlobalErrorState>((set) => ({
  error: null,
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
}));
