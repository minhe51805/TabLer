import { create } from "zustand";

/**
 * Open state for the Routine Editor modal. The sidebar's routine rows call
 * `open`; the modal (mounted from the Sidebar) renders while `isOpen`.
 */
interface RoutineEditorState {
  isOpen: boolean;
  connectionId: string | null;
  /** Preselect this routine when the modal opens. */
  routineName: string | null;
  routineSchema: string | null;
  open: (connectionId: string, routine?: { name: string; schema?: string }) => void;
  close: () => void;
}

export const useRoutineEditorStore = create<RoutineEditorState>((set) => ({
  isOpen: false,
  connectionId: null,
  routineName: null,
  routineSchema: null,
  open: (connectionId, routine) =>
    set({
      isOpen: true,
      connectionId,
      routineName: routine?.name ?? null,
      routineSchema: routine?.schema ?? null,
    }),
  close: () => set({ isOpen: false }),
}));
