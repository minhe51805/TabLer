import type { LucideIcon } from "lucide-react";
import {
  Box,
  Database,
  Download,
  LayoutDashboard,
  LoaderCircle,
  Map as MapIcon,
  Puzzle,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { emitAppToast } from "../utils/app-toast";
import { applyEngineRuntimeAvailability } from "../utils/plugin-driver-runtime";
import { invokeWithTimeout } from "../utils/tauri-utils";
import { ALL_DATABASES } from "./ConnectionForm/engine-registry";
import { usePluginStore } from "../stores/pluginStore";
import type { InstalledPluginRecord, PluginRegistryPackage } from "../types/plugin";

interface AppPluginManagerModalProps {
  onClose: () => void;
}

const CORE_MODULES = ["Explorer", "SQL Editor", "Metrics", "ER Diagram", "Terminal", "AI Assist"];

// Public plugin store on the marketing website — the browsable home for every
// downloadable driver bundle. Configurable per deployment.
const PLUGIN_STORE_URL = "https://tabler.app/plugins";

type PluginManagerSection =
  | "overview"
  | "installed"
  | "registry"
  | "core"
  | "adapters"
  | "roadmap";

export function AppPluginManagerModal({ onClose }: AppPluginManagerModalProps) {
  const { language } = useI18n();
  const installedPlugins = usePluginStore((s) => s.plugins);
  const isLoading = usePluginStore((s) => s.isLoading);
  const error = usePluginStore((s) => s.error);
  const registryPackages = usePluginStore((s) => s.registryPackages);
  const updates = usePluginStore((s) => s.updates);
  const isRegistryLoading = usePluginStore((s) => s.isRegistryLoading);
  const {
    loadPlugins,
    reloadPlugins,
    loadRegistry,
    checkUpdates,
    installRegistryPlugin,
    installPlugin,
    setPluginEnabled,
    rollbackPlugin,
    uninstallPlugin,
  } = usePluginStore();
  const [isInstalling, setIsInstalling] = useState(false);
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [activeSection, setActiveSection] =
    useState<PluginManagerSection>("overview");

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
        permissions: "Quyền truy cập",
        verified: "Đã xác minh",
        unverified: "Không an toàn",
        rollback: "Quay lại bản trước",
        rollbackSuccess: "Đã khôi phục plugin",
        registry: "Registry chính thức",
        browseRegistry: "Mở registry",
        storeCta: "Tải thêm plugin",
        storeHint: "Duyệt kho plugin đầy đủ trên web và tải bundle về.",
        registryEmpty: "Registry chưa có package tương thích cho nền tảng này.",
        updateAvailable: "Có bản cập nhật",
        installFromRegistry: "Cài đặt",
        updateFromRegistry: "Cập nhật",
        registryInstalled: "Đã cài từ registry",
        noPlugins: "Chưa có plugin local nào được cài.",
        note:
          "Format plugin và driver OpenSearch chỉ đọc chạy qua runtime khai báo, không thực thi mã native. Driver WASM khác vẫn ở trạng thái thử nghiệm và chưa được kích hoạt.",
        close: "Đóng",
        installSuccess: "Đã cài plugin",
        pluginUpdated: "Đã cập nhật trạng thái plugin",
        pluginRemoved: "Đã gỡ plugin",
        overview: "Tổng quan",
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
      permissions: "Permissions",
      verified: "Verified",
      unverified: "Unsafe",
      rollback: "Roll back",
      rollbackSuccess: "Plugin rolled back",
      registry: "Official registry",
      browseRegistry: "Browse registry",
      storeCta: "Get more plugins",
      storeHint: "Browse the full plugin store on the web and download bundles.",
      registryEmpty: "No compatible packages are published for this platform yet.",
      updateAvailable: "Update available",
      installFromRegistry: "Install",
      updateFromRegistry: "Update",
      registryInstalled: "Installed from registry",
      noPlugins: "No local plugin bundles installed yet.",
      note:
        "Format plugins and the read-only OpenSearch driver run through declarative runtimes without native code execution. Other WASM drivers remain experimental and disabled.",
      close: "Close",
      installSuccess: "Plugin installed",
      pluginUpdated: "Plugin state updated",
      pluginRemoved: "Plugin removed",
      overview: "Overview",
    };
  }, [language]);

  // Which native-crate engines this build actually compiled in (Cargo features);
  // mirrors the connection picker so the Plugin Manager reflects the same
  // "installed / connectable" truth instead of the static build-time flag. Fails
  // open (empty map) so the shipped build — which enables all of them — is
  // unchanged, and a failed report never hides a supported engine.
  const [nativeDriverAvailability, setNativeDriverAvailability] = useState<
    Record<string, boolean>
  >({});
  useEffect(() => {
    let cancelled = false;
    void invokeWithTimeout<Record<string, boolean>>(
      "get_native_driver_availability",
      {},
      5_000,
      "Checking installed database engines",
    )
      .then((availability) => {
        if (!cancelled && availability) setNativeDriverAvailability(availability);
      })
      .catch(() => {
        // Fail open: keep native engines visible; the backend still guards the
        // connect path with a clear "not compiled into this build" error.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Same single source of truth the connection picker uses
  // (applyEngineRuntimeAvailability), so an engine can never be "ready here /
  // roadmap there": PluginHttp engines gate on an installed/enabled driver,
  // native engines on the compiled build + installed sidecars.
  const databaseAdapters = applyEngineRuntimeAvailability(
    ALL_DATABASES,
    installedPlugins,
    nativeDriverAvailability,
  );
  const readyAdapters = databaseAdapters.filter((db) => db.supported);
  // A driver bundle that is installed but not active yet (disabled/unverified)
  // lives in "Installed local bundles" — it is no longer a roadmap-only engine,
  // so keep it out of the External plugin roadmap to avoid the contradictory
  // "installed here / roadmap there" state. Identical filter to the picker.
  const roadmapAdapters = databaseAdapters.filter(
    (db) => !db.supported && db.pluginHttpState !== "installed",
  );
  const latestRegistryPackages = useMemo(() => {
    const latest = new Map<string, PluginRegistryPackage>();
    for (const item of registryPackages) {
      const current = latest.get(item.manifest.id);
      if (
        !current ||
        item.manifest.version.localeCompare(current.manifest.version, undefined, {
          numeric: true,
        }) > 0
      ) {
        latest.set(item.manifest.id, item);
      }
    }
    return [...latest.values()];
  }, [registryPackages]);
  const installedPluginIds = useMemo(
    () => new Set(installedPlugins.map((plugin) => plugin.manifest.id)),
    [installedPlugins],
  );

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const handleReload = useCallback(async () => {
    await reloadPlugins();
  }, [reloadPlugins]);

  const handleBrowseRegistry = useCallback(async () => {
    await Promise.all([loadRegistry(), checkUpdates()]);
  }, [checkUpdates, loadRegistry]);

  const handleRegistryInstall = useCallback(
    async (plugin: PluginRegistryPackage) => {
      setBusyPluginId(plugin.manifest.id);
      try {
        const installed = await installRegistryPlugin(plugin.manifest.id);
        emitAppToast({
          tone: "success",
          title: copy.registryInstalled,
          description: `${installed.manifest.name} v${installed.manifest.version}`,
        });
      } catch {
        // The store exposes the backend validation error inside the modal.
      } finally {
        setBusyPluginId(null);
      }
    },
    [copy.registryInstalled, installRegistryPlugin],
  );

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
        const updated = await setPluginEnabled(plugin.manifest.id, !plugin.enabled);
        if (!updated) return;
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
        const removed = await uninstallPlugin(plugin.manifest.id);
        if (!removed) return;
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

  const handleRollbackPlugin = useCallback(
    async (plugin: InstalledPluginRecord) => {
      const confirmed = window.confirm(
        language === "vi"
          ? `Khôi phục "${plugin.manifest.name}" về phiên bản ${plugin.previousVersion ?? "trước"}?`
          : `Roll "${plugin.manifest.name}" back to ${plugin.previousVersion ?? "the previous version"}?`,
      );
      if (!confirmed) return;

      setBusyPluginId(plugin.manifest.id);
      try {
        const restored = await rollbackPlugin(plugin.manifest.id);
        emitAppToast({
          tone: "success",
          title: copy.rollbackSuccess,
          description: `${restored.manifest.name} v${restored.manifest.version}`,
        });
      } catch {
        // The store exposes the backend validation error inside the modal.
      } finally {
        setBusyPluginId(null);
      }
    },
    [copy.rollbackSuccess, language, rollbackPlugin],
  );

  const sections: Array<{
    id: PluginManagerSection;
    label: string;
    icon: LucideIcon;
    count?: number;
  }> = [
    { id: "overview", label: copy.overview, icon: LayoutDashboard },
    {
      id: "installed",
      label: copy.installed,
      icon: Puzzle,
      count: installedPlugins.length,
    },
    ...(latestRegistryPackages.length > 0 || isRegistryLoading
      ? [
          {
            id: "registry" as PluginManagerSection,
            label: copy.registry,
            icon: Download,
            count: latestRegistryPackages.length,
          },
        ]
      : []),
    { id: "core", label: copy.coreModules, icon: Box },
    {
      id: "adapters",
      label: copy.engineAdapters,
      icon: Database,
      count: readyAdapters.length,
    },
    { id: "roadmap", label: copy.planned, icon: MapIcon, count: roadmapAdapters.length },
  ];

  const handleSectionClick = (section: PluginManagerSection) => {
    setActiveSection(section);
    if (
      section === "registry" &&
      latestRegistryPackages.length === 0 &&
      !isRegistryLoading
    ) {
      void handleBrowseRegistry();
    }
  };

  return (
    <div className="app-help-modal-backdrop" onClick={onClose}>
      <div
        className="app-help-modal app-plugin-manager-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="app-help-modal-header">
          <div className="app-help-modal-copy">
            <span className="app-help-modal-kicker">{copy.kicker}</span>
            <h3 className="app-help-modal-title">{copy.title}</h3>
            <p className="app-help-modal-description">{copy.description}</p>
          </div>
          <div className="app-plugin-manager-header-actions">
            <button
              type="button"
              className="btn btn-secondary app-plugin-manager-toolbar-btn"
              onClick={() => void handleBrowseRegistry()}
              disabled={isRegistryLoading}
            >
              {isRegistryLoading ? (
                <LoaderCircle className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              <span>{copy.browseRegistry}</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary app-plugin-manager-toolbar-btn"
              onClick={handleReload}
              disabled={isLoading}
            >
              <RefreshCw
                className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`}
              />
              <span>{copy.reload}</span>
            </button>
            <button
              type="button"
              className="btn btn-primary app-plugin-manager-toolbar-btn"
              onClick={handleInstallPlugin}
              disabled={isInstalling}
            >
              {isInstalling ? (
                <LoaderCircle className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              <span>{copy.install}</span>
            </button>
            <button
              type="button"
              className="app-help-modal-close"
              onClick={onClose}
              aria-label={copy.close}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {error ? <div className="app-plugin-manager-error">{error}</div> : null}

        <div className="app-plugin-manager-layout">
          <nav className="app-plugin-manager-rail" aria-label={copy.title}>
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`app-plugin-manager-rail-item${
                  activeSection === section.id ? " is-active" : ""
                }`}
                onClick={() => handleSectionClick(section.id)}
              >
                <section.icon className="w-3.5 h-3.5" />
                <span className="app-plugin-manager-rail-label">
                  {section.label}
                </span>
                {typeof section.count === "number" ? (
                  <span className="app-plugin-manager-rail-count">
                    {section.count}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>

          <div className="app-plugin-manager-panel">
            {activeSection === "overview" ? (
              <>
                <div className="app-plugin-manager-panel-head">
                  <h4 className="app-plugin-manager-panel-title">
                    {copy.overview}
                  </h4>
                </div>
                <div className="app-help-modal-grid">
                  <div className="app-help-modal-metric">
                    <span className="app-help-modal-metric-label">
                      {copy.bundled}
                    </span>
                    <strong className="app-help-modal-metric-value">
                      {CORE_MODULES.length}
                    </strong>
                  </div>
                  <div className="app-help-modal-metric">
                    <span className="app-help-modal-metric-label">
                      {copy.adapterCount}
                    </span>
                    <strong className="app-help-modal-metric-value">
                      {readyAdapters.length}
                    </strong>
                  </div>
                </div>
                <div className="app-plugin-manager-note">
                  <Puzzle className="w-4 h-4" />
                  <span>{copy.note}</span>
                </div>
              </>
            ) : null}

            {activeSection === "registry" ? (
              <div className="app-plugin-manager-panel-group">
            <div className="app-plugin-manager-store-cta">
              <div className="app-plugin-manager-store-cta-copy">
                <strong>{copy.storeCta}</strong>
                <span>{copy.storeHint}</span>
              </div>
              <button
                type="button"
                className="app-plugin-manager-action-btn"
                onClick={() => window.open(PLUGIN_STORE_URL, "_blank", "noopener,noreferrer")}
              >
                <Download className="w-4 h-4" />
                <span>{copy.browseRegistry}</span>
              </button>
            </div>
            {isRegistryLoading && latestRegistryPackages.length === 0 ? (
              <div className="app-plugin-manager-empty"><LoaderCircle className="w-4 h-4 animate-spin" /></div>
            ) : latestRegistryPackages.length === 0 ? (
              <div className="app-plugin-manager-empty">{copy.registryEmpty}</div>
            ) : (
              <div className="app-plugin-manager-list">
                {latestRegistryPackages.map((plugin) => {
                  const update = updates.find((candidate) => candidate.pluginId === plugin.manifest.id);
                  const installed = installedPluginIds.has(plugin.manifest.id);
                  return (
                    <div key={plugin.manifest.id} className="app-plugin-manager-row">
                      <span className="app-plugin-manager-row-title">
                        {plugin.manifest.name} <small>v{plugin.manifest.version}</small>
                      </span>
                      <button
                        type="button"
                        className="app-plugin-manager-action-btn"
                        onClick={() => void handleRegistryInstall(plugin)}
                        disabled={busyPluginId === plugin.manifest.id || (installed && !update)}
                      >
                        <Download className="w-4 h-4" />
                        <span>{update ? copy.updateFromRegistry : copy.installFromRegistry}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
              </div>
            ) : null}

            {activeSection === "installed" ? (
              <div className="app-plugin-manager-panel-group">
                <div className="app-plugin-manager-panel-head">
                  <h4 className="app-plugin-manager-panel-title">
                    {copy.installed}
                  </h4>
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
                      <div className="app-plugin-manager-bundle-statuses">
                        <span
                          className={`app-plugin-manager-row-state ${plugin.verified ? "ready" : "danger"}`}
                          title={plugin.validationError ?? undefined}
                        >
                          {plugin.verified ? <ShieldCheck className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
                          {plugin.verified ? copy.verified : copy.unverified}
                        </span>
                        <span
                          className={`app-plugin-manager-row-state ${plugin.enabled ? "ready" : "roadmap"}`}
                        >
                          {plugin.enabled ? copy.enabled : copy.disabled}
                        </span>
                      </div>
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

                    {plugin.manifest.permissions.length > 0 ? (
                      <div className="app-plugin-manager-permissions">
                        <span>{copy.permissions}</span>
                        <div className="app-plugin-manager-bundle-tags">
                          {plugin.manifest.permissions.map((permission) => (
                            <span key={permission} className="app-help-modal-tag permission">
                              {permission}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {plugin.validationError ? (
                      <div className="app-plugin-manager-validation-error">
                        <ShieldAlert className="w-4 h-4" />
                        <span>{plugin.validationError}</span>
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
                      disabled={busyPluginId === plugin.manifest.id || (!plugin.enabled && !plugin.verified)}
                    >
                      {plugin.enabled ? <ToggleLeft className="w-4 h-4" /> : <ToggleRight className="w-4 h-4" />}
                      <span>{plugin.enabled ? copy.disable : copy.enable}</span>
                    </button>
                    {plugin.rollbackAvailable ? (
                      <button
                        type="button"
                        className="app-plugin-manager-action-btn"
                        onClick={() => void handleRollbackPlugin(plugin)}
                        disabled={busyPluginId === plugin.manifest.id}
                        title={plugin.previousVersion ? `v${plugin.previousVersion}` : undefined}
                      >
                        <RotateCcw className="w-4 h-4" />
                        <span>{copy.rollback}</span>
                      </button>
                    ) : null}
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
            ) : null}

            {activeSection === "core" ? (
              <div className="app-plugin-manager-panel-group">
                <div className="app-plugin-manager-panel-head">
                  <h4 className="app-plugin-manager-panel-title">
                    {copy.coreModules}
                  </h4>
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
            ) : null}

            {activeSection === "adapters" ? (
              <div className="app-plugin-manager-panel-group">
                <div className="app-plugin-manager-panel-head">
                  <h4 className="app-plugin-manager-panel-title">
                    {copy.engineAdapters}
                  </h4>
                  <span className="app-plugin-manager-badge accent">
                    <Database className="w-3.5 h-3.5" />
                    {readyAdapters.length} {copy.ready}
                  </span>
                </div>
          <div className="app-plugin-manager-list app-plugin-manager-grid">
            {readyAdapters.map((db) => (
              <div key={db.key} className="app-plugin-manager-row">
                <span className="app-plugin-manager-row-title">{db.label}</span>
                <span className="app-plugin-manager-row-state ready">{copy.ready}</span>
              </div>
            ))}
          </div>
              </div>
            ) : null}

            {activeSection === "roadmap" ? (
              <div className="app-plugin-manager-panel-group">
                <div className="app-plugin-manager-panel-head">
                  <h4 className="app-plugin-manager-panel-title">
                    {copy.planned}
                  </h4>
                  <span className="app-plugin-manager-badge muted">
                    <Download className="w-3.5 h-3.5" />
                    {roadmapAdapters.length} {copy.roadmap}
                  </span>
                </div>
          <div className="app-plugin-manager-list compact app-plugin-manager-grid">
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
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
