import { create } from "zustand";

interface ModalState {
  showAISettings: boolean;
  setShowAISettings: (show: boolean) => void;
  showAboutModal: boolean;
  setShowAboutModal: (show: boolean) => void;
  showPluginManager: boolean;
  setShowPluginManager: (show: boolean) => void;
  showKeyboardShortcutsModal: boolean;
  setShowKeyboardShortcutsModal: (show: boolean) => void;
  showThemeCustomizer: boolean;
  setShowThemeCustomizer: (show: boolean) => void;
  showConnectionExporter: boolean;
  setShowConnectionExporter: (show: boolean) => void;
  showConnectionImporter: boolean;
  setShowConnectionImporter: (show: boolean) => void;
  connectionFormIntent: "connect" | "bootstrap" | null;
  setConnectionFormIntent: (intent: "connect" | "bootstrap" | null) => void;
  showStartupConnectionManager: boolean;
  setShowStartupConnectionManager: (show: boolean) => void;
}

export const useModalStore = create<ModalState>((set) => ({
  showAISettings: false,
  setShowAISettings: (show) => set({ showAISettings: show }),
  showAboutModal: false,
  setShowAboutModal: (show) => set({ showAboutModal: show }),
  showPluginManager: false,
  setShowPluginManager: (show) => set({ showPluginManager: show }),
  showKeyboardShortcutsModal: false,
  setShowKeyboardShortcutsModal: (show) => set({ showKeyboardShortcutsModal: show }),
  showThemeCustomizer: false,
  setShowThemeCustomizer: (show) => set({ showThemeCustomizer: show }),
  showConnectionExporter: false,
  setShowConnectionExporter: (show) => set({ showConnectionExporter: show }),
  showConnectionImporter: false,
  setShowConnectionImporter: (show) => set({ showConnectionImporter: show }),
  connectionFormIntent: null,
  setConnectionFormIntent: (intent) => set({ connectionFormIntent: intent }),
  showStartupConnectionManager: true,
  setShowStartupConnectionManager: (show) => set({ showStartupConnectionManager: show }),
}));
