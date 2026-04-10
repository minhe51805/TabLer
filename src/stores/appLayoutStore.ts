import { create } from 'zustand';
import type { RowInspectorData } from "../components/RowInspector/RowInspector";

interface AppLayoutState {
  showTerminalPanel: boolean;
  setShowTerminalPanel: (show: boolean | ((current: boolean) => boolean)) => void;
  showQueryHistory: boolean;
  setShowQueryHistory: (show: boolean | ((current: boolean) => boolean)) => void;
  showSQLFavorites: boolean;
  setShowSQLFavorites: (show: boolean | ((current: boolean) => boolean)) => void;
  showRowInspector: boolean;
  setShowRowInspector: (show: boolean | ((current: boolean) => boolean)) => void;
  rowInspectorData: RowInspectorData | null;
  setRowInspectorData: (data: RowInspectorData | null | ((current: RowInspectorData | null) => RowInspectorData | null)) => void;
  leftPanel: "database" | "metrics";
  setLeftPanel: (panel: "database" | "metrics" | ((current: "database" | "metrics") => "database" | "metrics")) => void;
  isSidebarCollapsed: boolean;
  setIsSidebarCollapsed: (collapsed: boolean | ((current: boolean) => boolean)) => void;
  sidebarWidth: number;
  setSidebarWidth: (width: number | ((current: number) => number)) => void;
  isWindowMaximized: boolean;
  setIsWindowMaximized: (maximized: boolean | ((current: boolean) => boolean)) => void;
  isWindowFocused: boolean;
  setIsWindowFocused: (focused: boolean | ((current: boolean) => boolean)) => void;
  forceLauncherVisible: boolean;
  setForceLauncherVisible: (visible: boolean | ((current: boolean) => boolean)) => void;
}

export const useAppLayoutStore = create<AppLayoutState>((set) => ({
  showTerminalPanel: false,
  setShowTerminalPanel: (show) => set((state) => ({ showTerminalPanel: typeof show === 'function' ? show(state.showTerminalPanel) : show })),
  showQueryHistory: false,
  setShowQueryHistory: (show) => set((state) => ({ showQueryHistory: typeof show === 'function' ? show(state.showQueryHistory) : show })),
  showSQLFavorites: false,
  setShowSQLFavorites: (show) => set((state) => ({ showSQLFavorites: typeof show === 'function' ? show(state.showSQLFavorites) : show })),
  showRowInspector: false,
  setShowRowInspector: (show) => set((state) => ({ showRowInspector: typeof show === 'function' ? show(state.showRowInspector) : show })),
  rowInspectorData: null,
  setRowInspectorData: (data) => set((state) => ({ rowInspectorData: typeof data === 'function' ? data(state.rowInspectorData) : data })),
  leftPanel: "database",
  setLeftPanel: (panel) => set((state) => ({ leftPanel: typeof panel === 'function' ? panel(state.leftPanel) : panel })),
  isSidebarCollapsed: false,
  setIsSidebarCollapsed: (collapsed) => set((state) => ({ isSidebarCollapsed: typeof collapsed === 'function' ? collapsed(state.isSidebarCollapsed) : collapsed })),
  sidebarWidth: 320,
  setSidebarWidth: (width) => set((state) => ({ sidebarWidth: typeof width === 'function' ? width(state.sidebarWidth) : width })),
  isWindowMaximized: false,
  setIsWindowMaximized: (maximized) => set((state) => ({ isWindowMaximized: typeof maximized === 'function' ? maximized(state.isWindowMaximized) : maximized })),
  isWindowFocused: true,
  setIsWindowFocused: (focused) => set((state) => ({ isWindowFocused: typeof focused === 'function' ? focused(state.isWindowFocused) : focused })),
  forceLauncherVisible: false,
  setForceLauncherVisible: (visible) => set((state) => ({ forceLauncherVisible: typeof visible === 'function' ? visible(state.forceLauncherVisible) : visible })),
}));
