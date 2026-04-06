import {
  Box,
  Database,
  Download,
  LoaderCircle,
  Puzzle,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { emitAppToast } from "../utils/app-toast";
import { ALL_DATABASES } from "./ConnectionForm/engine-registry";
import { usePluginStore } from "../stores/pluginStore";
import type { InstalledPluginRecord } from "../types/plugin";

interface AppPluginManagerModalProps {
  onClose: () => void;
}

const CORE_MODULES = ["Explorer", "SQL Editor", "Metrics", "ER Diagram", "Terminal", "AI Assist"];

export function AppPluginManagerModal({ onClose }: AppPluginManagerModalProps) {
  const { language } = useI18n();
  const installedPlugins = usePluginStore((s) => s.plugins);
  const isLoading = usePluginStore((s) => s.isLoading);
  const error = usePluginStore((s) => s.error);
  const { loadPlugins, reloadPlugins, installPlugin, setPluginEnabled, uninstallPlugin } = usePluginStore();
  const [isInstalling, setIsInstalling] = useState(false);
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);

  const copy = useMemo(() => {
    if (language === "vi") {
      return {
        kicker: "Plugins",
        title: "Quản lý plugin",
        description:
          "Quản lý module lõi, adapter DB và plugin local theo bundle `.tableplugin` trong build hiện tại.",
        bundled: "Tích hợp sẵn",
        adapterCount: "Adapter DB",
        coreModules: "Module lõi",
        engineAdapters: "Adapter cơ sở dữ liệu",
        planned: "Lộ trình plugin ngoài",
        installed: "Plugin local đã cài",
        builtin: "Built-in",
        ready: "Sẵn sàng",
        roadmap: "Lộ trình",
        enabled: "Bật",
        disabled: "Tắt",
        install: "Cài plugin",
        reload: "Tải lại",
        remove: "Gỡ",
        enable: "Bật plugin",
        disable: "Tắt plugin",
        kind: "Loại",
        capabilities: "Khả năng",
        noPlugins: "Chưa có plugin local nào được cài.",
        note:
          "Plugin bundle hiện đã quản lý được theo manifest local. Bước tiếp theo là nạp adapter/runtime theo nhu cầu ngay từ bundle.",
        close: "Đóng",
        installSuccess: "Đã cài plugin",
        pluginUpdated: "Đã cập nhật trạng thái plugin",
        pluginRemoved: "Đã gỡ plugin",
      };
    }

    return {
      kicker: "Plugins",
      title: "Plugin Manager",
      description:
        "Manage core modules, database adapters, and local `.tableplugin` bundles in the current build.",
      bundled: "Bundled",
      adapterCount: "DB adapters",
      coreModules: "Core modules",
      engineAdapters: "Database adapters",
      planned: "External plugin roadmap",
      installed: "Installed local bundles",
      builtin: "Built-in",
      ready: "Ready",
      roadmap: "Roadmap",
      enabled: "Enabled",
      disabled: "Disabled",
      install: "Install plugin",
      reload: "Reload",
      remove: "Remove",
      enable: "Enable plugin",
      disable: "Disable plugin",
      kind: "Kind",
      capabilities: "Capabilities",
      noPlugins: "No local plugin bundles installed yet.",
      note:
        "Local plugin bundles are now tracked through manifests. The next step is loading runtime adapters and tools directly from those bundles.",
      close: "Close",
      installSuccess: "Plugin installed",
      pluginUpdated: "Plugin state updated",
      pluginRemoved: "Plugin removed",
    };
  }, [language]);

  const readyAdapters = ALL_DATABASES.filter((db) => db.supported);
  const roadmapAdapters = ALL_DATABASES.filter((db) => !db.supported);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const handleReload = useCallback(async () => {
    await reloadPlugins();
  }, [reloadPlugins]);

  const handleInstallPlugin = useCallback(async () => {
    setIsInstalling(true);
    try {
      const installedPlugin = await installPlugin();
      if (installedPlugin) {
        emitAppToast({
          tone: "success",
          title: copy.installSuccess,
          description: `${installedPlugin.manifest.name} v${installedPlugin.manifest.version}`,
        });
      }
    } finally {
      setIsInstalling(false);
    }
  }, [copy.installSuccess, installPlugin]);

  const handleTogglePlugin = useCallback(
    async (plugin: InstalledPluginRecord) => {
      setBusyPluginId(plugin.manifest.id);
      try {
        await setPluginEnabled(plugin.manifest.id, !plugin.enabled);
        emitAppToast({
          tone: "success",
          title: copy.pluginUpdated,
          description: `${plugin.manifest.name} · ${!plugin.enabled ? copy.enabled : copy.disabled}`,
        });
      } finally {
        setBusyPluginId(null);
      }
    },
    [copy.disabled, copy.enabled, copy.pluginUpdated, setPluginEnabled],
  );

  const handleRemovePlugin = useCallback(
    async (plugin: InstalledPluginRecord) => {
      const confirmed = window.confirm(
        language === "vi"
          ? `Gỡ plugin "${plugin.manifest.name}"?`
          : `Remove plugin "${plugin.manifest.name}"?`,
      );
      if (!confirmed) return;

      setBusyPluginId(plugin.manifest.id);
      try {
        await uninstallPlugin(plugin.manifest.id);
        emitAppToast({
          tone: "success",
          title: copy.pluginRemoved,
          description: plugin.manifest.name,
        });
      } finally {
        setBusyPluginId(null);
      }
    },
    [copy.pluginRemoved, language, uninstallPlugin],
  );

  return (
    <div className="app-help-modal-backdrop" onClick={onClose}>
      <div className="app-help-modal app-plugin-manager-modal" onClick={(event) => event.stopPropagation()}>
        <div className="app-help-modal-header">
          <div className="app-help-modal-copy">
            <span className="app-help-modal-kicker">{copy.kicker}</span>
            <h3 className="app-help-modal-title">{copy.title}</h3>
            <p className="app-help-modal-description">{copy.description}</p>
          </div>
          <button
            type="button"
            className="app-help-modal-close"
            onClick={onClose}
            aria-label={copy.close}
          >
            <X size={16} />
          </button>
        </div>

        <div className="app-help-modal-grid">
          <div className="app-help-modal-metric">
            <span className="app-help-modal-metric-label">{copy.bundled}</span>
            <strong className="app-help-modal-metric-value">{CORE_MODULES.length}</strong>
          </div>
          <div className="app-help-modal-metric">
            <span className="app-help-modal-metric-label">{copy.adapterCount}</span>
            <strong className="app-help-modal-metric-value">{readyAdapters.length}</strong>
          </div>
        </div>

        <div className="app-plugin-manager-toolbar">
          <button
            type="button"
            className="btn btn-secondary app-plugin-manager-toolbar-btn"
            onClick={handleReload}
            disabled={isLoading}
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
            <span>{copy.reload}</span>
          </button>
          <button
            type="button"
            className="btn btn-primary app-plugin-manager-toolbar-btn"
            onClick={handleInstallPlugin}
            disabled={isInstalling}
          >
            {isInstalling ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            <span>{copy.install}</span>
          </button>
        </div>

        {error ? <div className="app-plugin-manager-error">{error}</div> : null}

        <div className="app-plugin-manager-section">
          <div className="app-plugin-manager-section-head">
            <span className="app-help-modal-section-label">{copy.installed}</span>
            <span className="app-plugin-manager-badge accent">
              <Puzzle className="w-3.5 h-3.5" />
              {installedPlugins.length}
            </span>
          </div>

          {installedPlugins.length === 0 ? (
            <div className="app-plugin-manager-empty">{copy.noPlugins}</div>
          ) : (
            <div className="app-plugin-manager-bundle-list">
              {installedPlugins.map((plugin) => (
                <div key={plugin.manifest.id} className="app-plugin-manager-bundle-card">
                  <div className="app-plugin-manager-bundle-copy">
                    <div className="app-plugin-manager-bundle-head">
                      <div>
                        <div className="app-plugin-manager-bundle-title">
                          {plugin.manifest.name}
                          <span className="app-plugin-manager-bundle-version">
                            v{plugin.manifest.version}
                          </span>
                        </div>
                        <div className="app-plugin-manager-bundle-meta">
                          <span>{copy.kind}: {plugin.manifest.kind}</span>
                          {plugin.manifest.author ? <span>{plugin.manifest.author}</span> : null}
                        </div>
                      </div>
                      <span
                        className={`app-plugin-manager-row-state ${
                          plugin.enabled ? "ready" : "roadmap"
                        }`}
                      >
                        {plugin.enabled ? copy.enabled : copy.disabled}
                      </span>
                    </div>

                    {plugin.manifest.description ? (
                      <p className="app-plugin-manager-bundle-description">
                        {plugin.manifest.description}
                      </p>
                    ) : null}

                    {plugin.manifest.capabilities.length > 0 ? (
                      <div className="app-plugin-manager-bundle-tags">
                        {plugin.manifest.capabilities.map((capability) => (
                          <span key={capability} className="app-help-modal-tag">
                            {capability}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    <code className="app-plugin-manager-bundle-path" title={plugin.bundlePath}>
                      {plugin.bundlePath}
                    </code>
                  </div>

                  <div className="app-plugin-manager-bundle-actions">
                    <button
                      type="button"
                      className="app-plugin-manager-action-btn"
                      onClick={() => handleTogglePlugin(plugin)}
                      disabled={busyPluginId === plugin.manifest.id}
                    >
                      {plugin.enabled ? <ToggleLeft className="w-4 h-4" /> : <ToggleRight className="w-4 h-4" />}
                      <span>{plugin.enabled ? copy.disable : copy.enable}</span>
                    </button>
                    <button
                      type="button"
                      className="app-plugin-manager-action-btn danger"
                      onClick={() => handleRemovePlugin(plugin)}
                      disabled={busyPluginId === plugin.manifest.id}
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>{copy.remove}</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="app-plugin-manager-section">
          <div className="app-plugin-manager-section-head">
            <span className="app-help-modal-section-label">{copy.coreModules}</span>
            <span className="app-plugin-manager-badge">
              <Box className="w-3.5 h-3.5" />
              {copy.builtin}
            </span>
          </div>
          <div className="app-help-modal-tags">
            {CORE_MODULES.map((moduleName) => (
              <span key={moduleName} className="app-help-modal-tag">
                {moduleName}
              </span>
            ))}
          </div>
        </div>

        <div className="app-plugin-manager-section">
          <div className="app-plugin-manager-section-head">
            <span className="app-help-modal-section-label">{copy.engineAdapters}</span>
            <span className="app-plugin-manager-badge accent">
              <Database className="w-3.5 h-3.5" />
              {readyAdapters.length} {copy.ready}
            </span>
          </div>
          <div className="app-plugin-manager-list">
            {readyAdapters.map((db) => (
              <div key={db.key} className="app-plugin-manager-row">
                <span className="app-plugin-manager-row-title">{db.label}</span>
                <span className="app-plugin-manager-row-state ready">{copy.ready}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="app-plugin-manager-section">
          <div className="app-plugin-manager-section-head">
            <span className="app-help-modal-section-label">{copy.planned}</span>
            <span className="app-plugin-manager-badge muted">
              <Download className="w-3.5 h-3.5" />
              {roadmapAdapters.length} {copy.roadmap}
            </span>
          </div>
          <div className="app-plugin-manager-list compact">
            {roadmapAdapters.length === 0 ? (
              <div className="app-plugin-manager-row">
                <span className="app-plugin-manager-row-title">{copy.ready}</span>
                <span className="app-plugin-manager-row-state ready">{copy.builtin}</span>
              </div>
            ) : (
              roadmapAdapters.map((db) => (
                <div key={db.key} className="app-plugin-manager-row">
                  <span className="app-plugin-manager-row-title">{db.label}</span>
                  <span className="app-plugin-manager-row-state roadmap">{copy.roadmap}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="app-plugin-manager-note">
          <Puzzle className="w-4 h-4" />
          <span>{copy.note}</span>
        </div>

        <div className="app-help-modal-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onClose}
          >
            {copy.close}
          </button>
        </div>
      </div>
    </div>
  );
}
