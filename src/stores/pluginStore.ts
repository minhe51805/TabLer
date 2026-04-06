import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { InstalledPluginRecord } from "../types/plugin";

interface PluginStoreState {
  plugins: InstalledPluginRecord[];
  isLoading: boolean;
  error: string | null;

  loadPlugins: () => Promise<void>;
  reloadPlugins: () => Promise<void>;
  installPlugin: () => Promise<InstalledPluginRecord | null>;
  setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
  uninstallPlugin: (pluginId: string) => Promise<void>;
}

export const usePluginStore = create<PluginStoreState>((set) => ({
  plugins: [],
  isLoading: false,
  error: null,

  loadPlugins: async () => {
    set({ isLoading: true, error: null });
    try {
      const plugins = await invoke<InstalledPluginRecord[]>("list_installed_plugins");
      set({ plugins, isLoading: false });
    } catch (e) {
      set({ error: String(e), isLoading: false });
    }
  },

  reloadPlugins: async () => {
    set({ isLoading: true, error: null });
    try {
      const plugins = await invoke<InstalledPluginRecord[]>("reload_installed_plugins");
      set({ plugins, isLoading: false });
    } catch (e) {
      set({ error: String(e), isLoading: false });
    }
  },

  installPlugin: async () => {
    try {
      const plugin = await invoke<InstalledPluginRecord>("install_plugin_bundle");
      set((state) => {
        const idx = state.plugins.findIndex((p) => p.manifest.id === plugin.manifest.id);
        if (idx >= 0) {
          const next = [...state.plugins];
          next[idx] = plugin;
          return { plugins: next };
        }
        return { plugins: [...state.plugins, plugin] };
      });
      return plugin;
    } catch (e) {
      if (!/No plugin bundle selected/i.test(String(e))) {
        set({ error: String(e) });
      }
      return null;
    }
  },

  setPluginEnabled: async (pluginId: string, enabled: boolean) => {
    try {
      const updated = await invoke<InstalledPluginRecord>("set_plugin_enabled", {
        pluginId,
        enabled,
      });
      set((state) => ({
        plugins: state.plugins.map((p) =>
          p.manifest.id === updated.manifest.id ? updated : p,
        ),
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  uninstallPlugin: async (pluginId: string) => {
    try {
      await invoke("uninstall_plugin_bundle", { pluginId });
      set((state) => ({
        plugins: state.plugins.filter((p) => p.manifest.id !== pluginId),
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
