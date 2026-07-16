import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  InstalledPluginRecord,
  PluginRegistryIndex,
  PluginRegistryPackage,
  PluginUpdateCandidate,
} from "../types/plugin";

interface PluginStoreState {
  plugins: InstalledPluginRecord[];
  isLoading: boolean;
  hasLoaded: boolean;
  error: string | null;
  registryPackages: PluginRegistryPackage[];
  updates: PluginUpdateCandidate[];
  isRegistryLoading: boolean;

  loadPlugins: () => Promise<void>;
  reloadPlugins: () => Promise<void>;
  loadRegistry: () => Promise<void>;
  checkUpdates: () => Promise<void>;
  installRegistryPlugin: (pluginId: string) => Promise<InstalledPluginRecord>;
  installPlugin: () => Promise<InstalledPluginRecord | null>;
  setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<InstalledPluginRecord | null>;
  rollbackPlugin: (pluginId: string) => Promise<InstalledPluginRecord>;
  uninstallPlugin: (pluginId: string) => Promise<boolean>;
}

export const usePluginStore = create<PluginStoreState>((set) => ({
  plugins: [],
  isLoading: false,
  hasLoaded: false,
  error: null,
  registryPackages: [],
  updates: [],
  isRegistryLoading: false,

  loadPlugins: async () => {
    set({ isLoading: true, error: null });
    try {
      const plugins = await invoke<InstalledPluginRecord[]>("list_installed_plugins");
      set({ plugins, isLoading: false, hasLoaded: true });
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
      return updated;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  loadRegistry: async () => {
    set({ isRegistryLoading: true, error: null });
    try {
      const registry = await invoke<PluginRegistryIndex>("get_plugin_registry");
      set({ registryPackages: registry.packages, isRegistryLoading: false });
    } catch (error) {
      set({ error: String(error), isRegistryLoading: false });
    }
  },

  checkUpdates: async () => {
    set({ isRegistryLoading: true, error: null });
    try {
      const updates = await invoke<PluginUpdateCandidate[]>("check_plugin_updates");
      set({ updates, isRegistryLoading: false });
    } catch (error) {
      set({ error: String(error), isRegistryLoading: false });
    }
  },

  installRegistryPlugin: async (pluginId: string) => {
    set({ isRegistryLoading: true, error: null });
    try {
      const installed = await invoke<InstalledPluginRecord>("install_registry_plugin", {
        pluginId,
      });
      set((state) => ({
        plugins: state.plugins.some((plugin) => plugin.manifest.id === installed.manifest.id)
          ? state.plugins.map((plugin) =>
              plugin.manifest.id === installed.manifest.id ? installed : plugin,
            )
          : [...state.plugins, installed],
        updates: state.updates.filter((update) => update.pluginId !== installed.manifest.id),
        isRegistryLoading: false,
      }));
      return installed;
    } catch (error) {
      set({ error: String(error), isRegistryLoading: false });
      throw error;
    }
  },

  rollbackPlugin: async (pluginId: string) => {
    try {
      const updated = await invoke<InstalledPluginRecord>("rollback_plugin_bundle", {
        pluginId,
      });
      set((state) => ({
        plugins: state.plugins.map((plugin) =>
          plugin.manifest.id === updated.manifest.id ? updated : plugin,
        ),
      }));
      return updated;
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  uninstallPlugin: async (pluginId: string) => {
    try {
      await invoke("uninstall_plugin_bundle", { pluginId });
      set((state) => ({
        plugins: state.plugins.filter((p) => p.manifest.id !== pluginId),
      }));
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },
}));
