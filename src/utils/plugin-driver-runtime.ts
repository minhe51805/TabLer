import type { InstalledPluginRecord, PluginDriverContribution } from "../types/plugin";

export interface RuntimePluginDriver extends PluginDriverContribution {
  pluginId: string;
  pluginName: string;
}

export function getEnabledPluginDrivers(
  plugins: InstalledPluginRecord[],
): RuntimePluginDriver[] {
  return plugins.flatMap((plugin) => {
    if (!plugin.enabled || !plugin.verified || plugin.validationError) return [];
    if (!plugin.manifest.capabilities.includes("database")) return [];
    return plugin.manifest.contributes.drivers.map((driver) => ({
      ...driver,
      pluginId: plugin.manifest.id,
      pluginName: plugin.manifest.name,
    }));
  });
}

export function findStableOpenSearchDriver(plugins: InstalledPluginRecord[]) {
  return getEnabledPluginDrivers(plugins).find(
    (driver) =>
      driver.protocol === "opensearch" &&
      driver.runtime === "declarative-http-v1" &&
      driver.status === "stable",
  );
}
