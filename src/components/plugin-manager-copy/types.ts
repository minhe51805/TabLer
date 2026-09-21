export interface PluginManagerCopy {
  kicker: string;
  title: string;
  description: string;
  bundled: string;
  adapterCount: string;
  coreModules: string;
  engineAdapters: string;
  planned: string;
  installed: string;
  builtin: string;
  ready: string;
  roadmap: string;
  enabled: string;
  disabled: string;
  install: string;
  reload: string;
  remove: string;
  enable: string;
  disable: string;
  kind: string;
  capabilities: string;
  permissions: string;
  verified: string;
  unverified: string;
  rollback: string;
  rollbackSuccess: string;
  registry: string;
  browseRegistry: string;
  storeCta: string;
  storeHint: string;
  registryEmpty: string;
  updateAvailable: string;
  installFromRegistry: string;
  updateFromRegistry: string;
  registryInstalled: string;
  noPlugins: string;
  note: string;
  close: string;
  installSuccess: string;
  pluginUpdated: string;
  pluginRemoved: string;
  overview: string;
  /** Registry URL settings field shown above the marketplace list. */
  registryUrlLabel: string;
  registryUrlHint: string;
  /** Label prefix for the engine a driver plugin contributes. */
  engine: string;
  /** Badge shown on registry rows whose plugin is already installed. */
  installedBadge: string;
  /** Fallback phrase when an installed plugin has no recorded previous version. */
  previousVersionFallback: string;
  /** Confirm dialogs (name is interpolated by the caller). */
  confirmRemove: (name: string) => string;
  confirmRollback: (name: string, previousVersion: string) => string;
}
