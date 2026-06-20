import { useState, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Plus, Trash2, Brain, Sparkles, Loader2, Check, Download } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { invokeWithTimeout } from "../../utils/tauri-utils";
import { getCurrentAppLanguage } from "../../i18n";
import type { AIProviderConfig, LocalOllamaSetupProgressEvent, LocalOllamaStatus } from "../../types";

const PROVIDER_NAMES: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Claude",
    gemini: "Gemini",
    openrouter: "OpenRouter",
    ollama: "Ollama",
    custom: "Custom",
};

const LOCAL_OLLAMA_EVENT = "ollama-setup-progress";

interface Props {
    onClose: () => void;
}

function normalizeProviderDrafts(drafts: AIProviderConfig[]) {
    const normalized = drafts.map((config) => ({
        ...config,
        is_primary: config.is_primary ?? false,
        allow_schema_context: config.allow_schema_context ?? false,
        allow_inline_completion: config.allow_inline_completion ?? false,
    }));

    const primaryIndex = normalized.findIndex((config) => config.is_enabled && config.is_primary);
    const enabledIndex = normalized.findIndex((config) => config.is_enabled);
    const activeIndex = primaryIndex >= 0 ? primaryIndex : enabledIndex;

    return normalized.map((config, index) => ({
        ...config,
        is_primary: activeIndex >= 0 ? index === activeIndex : false,
    }));
}

function getProviderDefaultEndpoint(config: Pick<AIProviderConfig, "provider_type" | "model">) {
    switch (config.provider_type) {
        case "openai":
            return "https://api.openai.com/v1/chat/completions";
        case "anthropic":
            return "https://api.anthropic.com/v1/messages";
        case "gemini":
            return `https://generativelanguage.googleapis.com/v1beta/models/${config.model.trim() || "{model}"}:generateContent`;
        case "openrouter":
            return "https://openrouter.ai/api/v1/chat/completions";
        case "ollama":
            return "http://localhost:11434/v1/chat/completions";
        case "custom":
            return "https://api.yourdomain.com/v1/chat/completions";
        default:
            return "";
    }
}

function getEndpointFieldCopy(config: Pick<AIProviderConfig, "provider_type" | "model">) {
    if (config.provider_type === "custom") {
        return {
            label: "Custom URL",
            hint: "Required for custom providers. TableR will send an OpenAI-compatible chat request to this URL.",
            placeholder: getProviderDefaultEndpoint(config),
        };
    }

    if (config.provider_type === "ollama") {
        return {
            label: "Custom URL",
            hint: "Optional. Leave blank to use the local Ollama default endpoint.",
            placeholder: getProviderDefaultEndpoint(config),
        };
    }

    return {
        label: "Custom URL",
        hint: "Optional. Leave blank to use the provider's default endpoint.",
        placeholder: getProviderDefaultEndpoint(config),
    };
}

export function AISettingsModal({ onClose }: Props) {
    const saveAIConfigs = useAppStore((state) => state.saveAIConfigs);
    const loadAIConfigs = useAppStore((state) => state.loadAIConfigs);
    const getLocalOllamaStatus = useAppStore((state) => state.getLocalOllamaStatus);
    const setupLocalOllama = useAppStore((state) => state.setupLocalOllama);

    const [configs, setConfigs] = useState<AIProviderConfig[]>([]);
    const [storedKeyStatus, setStoredKeyStatus] = useState<Record<string, boolean>>({});
    const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
    const [clearedKeyIds, setClearedKeyIds] = useState<string[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [connectionCheckStatus, setConnectionCheckStatus] = useState<"idle" | "checking" | "ok" | "error">("idle");
    const [connectionCheckMessage, setConnectionCheckMessage] = useState<string | null>(null);
    const [isProviderMenuOpen, setIsProviderMenuOpen] = useState(false);
    const [localOllamaStatus, setLocalOllamaStatus] = useState<LocalOllamaStatus | null>(null);
    const [isLoadingLocalOllamaStatus, setIsLoadingLocalOllamaStatus] = useState(true);
    const [localOllamaStatusError, setLocalOllamaStatusError] = useState<string | null>(null);
    const [showLocalOllamaConsent, setShowLocalOllamaConsent] = useState(false);
    const [isSettingUpLocalOllama, setIsSettingUpLocalOllama] = useState(false);
    const [localOllamaProgress, setLocalOllamaProgress] = useState<LocalOllamaSetupProgressEvent>({
        step: "idle",
        message: "Waiting to start local AI setup.",
        percent: 0,
        isEstimated: true,
    });
    const [localOllamaConsentNotice, setLocalOllamaConsentNotice] = useState<string | null>(null);
    const [localOllamaConsentTone, setLocalOllamaConsentTone] = useState<"info" | "success" | "error">("info");
    const providerMenuRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        let isMounted = true;

        loadAIConfigs()
            .then(({ aiConfigs, aiKeyStatus }) => {
                if (!isMounted) return;

                setConfigs(normalizeProviderDrafts(aiConfigs));
                setStoredKeyStatus(aiKeyStatus);
                setKeyDrafts({});
                setClearedKeyIds([]);
                setSaveError(null);
                setEditingId(aiConfigs[0]?.id ?? null);
            })
            .catch((error) => {
                if (!isMounted) return;
                setSaveError(error instanceof Error ? error.message : String(error));
            });

        setIsLoadingLocalOllamaStatus(true);
        getLocalOllamaStatus()
            .then((status) => {
                if (!isMounted) return;
                setLocalOllamaStatus(status);
                setLocalOllamaStatusError(null);
            })
            .catch((error) => {
                if (!isMounted) return;
                setLocalOllamaStatusError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
                if (!isMounted) return;
                setIsLoadingLocalOllamaStatus(false);
            });

        return () => {
            isMounted = false;
        };
    }, [getLocalOllamaStatus, loadAIConfigs]);

    useEffect(() => {
        if (configs.length === 0) {
            if (editingId !== null) {
                setEditingId(null);
            }
            return;
        }

        if (!editingId || !configs.some((config) => config.id === editingId)) {
            setEditingId(configs[0].id);
        }
    }, [configs, editingId]);

    useEffect(() => {
        setConnectionCheckStatus("idle");
        setConnectionCheckMessage(null);
    }, [editingId]);

    useEffect(() => {
        if (!isProviderMenuOpen) return;

        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (providerMenuRef.current && target && !providerMenuRef.current.contains(target)) {
                setIsProviderMenuOpen(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [isProviderMenuOpen]);

    useEffect(() => {
        let isMounted = true;
        const unlistenPromise = listen<LocalOllamaSetupProgressEvent>(LOCAL_OLLAMA_EVENT, (event) => {
            if (!isMounted) return;
            setLocalOllamaProgress(event.payload);
        });

        return () => {
            isMounted = false;
            unlistenPromise
                .then((unlisten) => unlisten())
                .catch(() => { /* Ignore listener cleanup failures */ });
        };
    }, []);

    const handleAdd = () => {
        setSaveError(null);
        const newId = crypto.randomUUID();
        setConfigs((current) => normalizeProviderDrafts([...current, {
            id: newId,
            name: "New Provider",
            provider_type: "openai",
            endpoint: "",
            model: "gpt-4o-mini",
            is_enabled: true,
            is_primary: current.every((config) => !config.is_enabled),
            allow_schema_context: true,
            allow_inline_completion: false,
        }]));
        setEditingId(newId);
    };

    const handleDelete = (id: string) => {
        setSaveError(null);
        const remainingConfigs = normalizeProviderDrafts(configs.filter((c) => c.id !== id));
        setConfigs(remainingConfigs);
        const nextDrafts = { ...keyDrafts };
        delete nextDrafts[id];
        setKeyDrafts(nextDrafts);
        setStoredKeyStatus((prev) => {
            const nextStatus = { ...prev };
            delete nextStatus[id];
            return nextStatus;
        });
        setClearedKeyIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
        if (editingId === id) {
            setEditingId(remainingConfigs[0]?.id ?? null);
        }
    };

    const handleSave = async () => {
        const apiKeyUpdates = Object.fromEntries(
            Object.entries(keyDrafts).filter(([, value]) => value.trim().length > 0)
        );
        setIsSaving(true);
        setSaveError(null);
        try {
            const { aiConfigs, aiKeyStatus } = await saveAIConfigs(configs, apiKeyUpdates, clearedKeyIds);
            setConfigs(normalizeProviderDrafts(aiConfigs));
            setStoredKeyStatus(aiKeyStatus);
            onClose();
        } catch (error) {
            setSaveError(error instanceof Error ? error.message : String(error));
        } finally {
            setIsSaving(false);
        }
    };

    const handleCheckConnection = async () => {
        if (!activeConfig) return;
        if (!activeConfig.is_enabled) {
            setConnectionCheckStatus("error");
            setConnectionCheckMessage("Enable this provider before checking the connection.");
            return;
        }
        if (!activeConfig.is_primary) {
            setConnectionCheckStatus("error");
            setConnectionCheckMessage("Set this provider as active to check connectivity.");
            return;
        }
        const apiKeyUpdates = Object.fromEntries(
            Object.entries(keyDrafts).filter(([, value]) => value.trim().length > 0)
        );
        setConnectionCheckStatus("checking");
        setConnectionCheckMessage(null);
        setSaveError(null);
        try {
            const { aiConfigs, aiKeyStatus } = await saveAIConfigs(configs, apiKeyUpdates, clearedKeyIds);
            setConfigs(normalizeProviderDrafts(aiConfigs));
            setStoredKeyStatus(aiKeyStatus);
            const connectionTimeoutMs = activeConfig.provider_type === "ollama" ? 180_000 : 20_000;
            const resp = await invokeWithTimeout<{ text: string; error?: string }>(
                "ask_ai",
                { request: { prompt: "ping", context: "", mode: "panel", intent: "sql", language: getCurrentAppLanguage(), history: [] } },
                connectionTimeoutMs,
                "AI provider check"
            );
            if (resp.error) {
                throw new Error(resp.error);
            }
            setConnectionCheckStatus("ok");
            setConnectionCheckMessage("Connection OK");
        } catch (error) {
            setConnectionCheckStatus("error");
            const message = error instanceof Error ? error.message : String(error);
            setConnectionCheckMessage(message);
            setSaveError(message);
        }
    };

    const updateConfig = (id: string, updates: Partial<AIProviderConfig>) => {
        setSaveError(null);
        setConfigs((current) => normalizeProviderDrafts(current.map((config) => {
            if (config.id !== id) return config;
            return {
                ...config,
                ...updates,
                is_enabled: updates.is_primary ? true : updates.is_enabled ?? config.is_enabled,
            };
        })));
    };

    const setPrimaryProvider = (id: string) => {
        setSaveError(null);
        setConfigs((current) => normalizeProviderDrafts(current.map((config) => (
            config.id === id
                ? { ...config, is_enabled: true, is_primary: true }
                : { ...config, is_primary: false }
        ))));
    };

    const activeConfig = configs.find(c => c.id === editingId);
    const endpointFieldCopy = activeConfig ? getEndpointFieldCopy(activeConfig) : null;
    const enabledCount = configs.filter((config) => config.is_enabled).length;
    const inUseCount = configs.filter((config) => config.is_enabled && config.is_primary).length;
    const hasStoredKey = activeConfig ? storedKeyStatus[activeConfig.id] && !clearedKeyIds.includes(activeConfig.id) : false;
    const isActiveProviderInUse = !!activeConfig?.is_enabled && !!activeConfig?.is_primary;
    const connectionStatusLabel =
        connectionCheckStatus === "checking"
            ? "Checking..."
            : connectionCheckStatus === "ok"
                ? "Connection OK"
                : connectionCheckStatus === "error"
                    ? "Check failed"
                    : isActiveProviderInUse
                        ? "Using for AI"
                        : activeConfig?.is_enabled
                            ? "ENABLED ONLY"
                            : "DISABLED";
    const connectionStatusClass = connectionCheckStatus === "ok"
        ? "ai-settings-workspace-status is-ok"
        : connectionCheckStatus === "error"
            ? "ai-settings-workspace-status is-error"
            : "ai-settings-workspace-status";

    const handleKeyDraftChange = (providerId: string, value: string) => {
        setSaveError(null);
        setKeyDrafts((prev) => ({ ...prev, [providerId]: value }));
        setClearedKeyIds((prev) => prev.filter((id) => id !== providerId));
    };

    const handleClearStoredKey = (providerId: string) => {
        setSaveError(null);
        setKeyDrafts((prev) => {
            const nextDrafts = { ...prev };
            delete nextDrafts[providerId];
            return nextDrafts;
        });
        setStoredKeyStatus((prev) => ({ ...prev, [providerId]: false }));
        setClearedKeyIds((prev) => (prev.includes(providerId) ? prev : [...prev, providerId]));
    };

    const refreshLocalOllamaStatus = async () => {
        setIsLoadingLocalOllamaStatus(true);
        setLocalOllamaStatusError(null);
        try {
            const status = await getLocalOllamaStatus();
            setLocalOllamaStatus(status);
        } catch (error) {
            setLocalOllamaStatusError(error instanceof Error ? error.message : String(error));
        } finally {
            setIsLoadingLocalOllamaStatus(false);
        }
    };

    const handleSetupLocalOllama = async () => {
        setIsSettingUpLocalOllama(true);
        setSaveError(null);
        setLocalOllamaStatusError(null);
        setLocalOllamaProgress({
            step: "prepare",
            message: "Preparing local AI setup...",
            percent: 5,
            isEstimated: true,
        });
        setLocalOllamaConsentNotice(null);
        setLocalOllamaConsentTone("info");
        try {
            const result = await setupLocalOllama();
            setConfigs(normalizeProviderDrafts(result.aiConfigs));
            setStoredKeyStatus(result.aiKeyStatus);
            setKeyDrafts({});
            setClearedKeyIds([]);
            setLocalOllamaStatus(result.status);
            setEditingId(result.status.configuredProviderId ?? result.aiConfigs[0]?.id ?? null);
            setConnectionCheckStatus("idle");
            setConnectionCheckMessage(result.message);
            setLocalOllamaProgress({
                step: "done",
                message: result.message,
                percent: 100,
                isEstimated: false,
            });
            setLocalOllamaConsentNotice(result.message);
            setLocalOllamaConsentTone("success");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setSaveError(message);
            setLocalOllamaStatusError(message);
            setLocalOllamaProgress((current) => ({
                ...current,
                message,
            }));
            setLocalOllamaConsentNotice(message);
            setLocalOllamaConsentTone("error");
        } finally {
            setIsSettingUpLocalOllama(false);
            void refreshLocalOllamaStatus();
        }
    };

    const localOllamaPrimaryText = localOllamaStatus?.configuredAsPrimary
        ? "Active in TableR"
        : localOllamaStatus?.hasConfiguredProvider
            ? "Configured"
            : "Not configured";
    const localOllamaButtonLabel = isSettingUpLocalOllama
        ? "Setting up..."
        : localOllamaStatus?.hasRecommendedModel && localOllamaStatus?.hasConfiguredProvider
            ? "Repair or reselect"
            : localOllamaStatus?.isInstalled
                ? "Finish local setup"
                : "Set up local Gemma 4 E2B";
    const disableModalActions = isSaving || isSettingUpLocalOllama;
    const shouldShowProgressNumber = isSettingUpLocalOllama || localOllamaConsentTone !== "info";
    const progressPercentValue = Math.max(0, Math.min(100, Math.round(localOllamaProgress.percent)));
    const localOllamaProgressLabel = shouldShowProgressNumber
        ? `${localOllamaProgress.isEstimated ? "~" : ""}${progressPercentValue}%`
        : "Ready";
    const localOllamaProgressWidth = shouldShowProgressNumber
        ? `${Math.max(4, progressPercentValue || 4)}%`
        : "4%";

    return (
        <div className="ai-settings-overlay">
            <div className="ai-settings-modal">
                {/* Header */}
                <header className="ai-settings-header">
                    <div className="ai-settings-header-copy">
                        <span className="ai-settings-kicker">AI WORKSPACE</span>
                        <h2 className="ai-settings-title">Provider Settings</h2>
                        <p className="ai-settings-subtitle">
                            Manage model providers, credentials, and which assistant is active inside the editor.
                        </p>
                    </div>
                    <div className="ai-settings-header-actions">
                        <button type="button" onClick={onClose} className="ai-settings-btn-cancel" disabled={disableModalActions}>
                            Cancel
                        </button>
                        <button type="button" onClick={handleSave} className="ai-settings-btn-save" disabled={disableModalActions}>
                            {isSaving ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <>
                                    <Check className="w-4 h-4" />
                                    Save All
                                </>
                            )}
                        </button>
                    </div>
                </header>

                {saveError && (
                    <div className="ai-settings-error">{saveError}</div>
                )}

                <div className="ai-settings-body">
                    {/* Left Sidebar - Provider List */}
                    <aside className="ai-settings-sidebar">
                        <div className="ai-settings-sidebar-header">
                            <h3 className="ai-settings-sidebar-title">AI Providers</h3>
                            <div className="ai-settings-sidebar-pills">
                                <span className="ai-settings-pill">{configs.length} CONFIGURED</span>
                                <span className="ai-settings-pill">{enabledCount} ENABLED</span>
                                <span className="ai-settings-pill ai-settings-pill-active">{inUseCount} IN USE</span>
                            </div>
                            <button type="button" onClick={handleAdd} className="ai-settings-add-btn" disabled={isSettingUpLocalOllama}>
                                <Plus className="w-3.5 h-3.5" />
                                <span>Add</span>
                            </button>
                        </div>

                        {configs.length === 0 ? (
                            <div className="ai-settings-empty">
                                <Brain className="w-10 h-10" />
                                <h4>No providers yet</h4>
                                <p>Add your first model provider to enable AI chat.</p>
                                <button type="button" onClick={handleAdd} className="ai-settings-btn-primary" disabled={isSettingUpLocalOllama}>
                                    <Plus className="w-4 h-4" />
                                    Create Provider
                                </button>
                            </div>
                        ) : (
                            <div className="ai-provider-list">
                                {configs.map((config) => (
                                    <button
                                        key={config.id}
                                        type="button"
                                        onClick={() => setEditingId(config.id)}
                                        className={`ai-provider-card ${editingId === config.id ? "active" : ""} ${config.is_enabled && config.is_primary ? "in-use" : ""}`}
                                        disabled={isSettingUpLocalOllama}
                                    >
                                        <div className="ai-provider-card-avatar" aria-hidden="true">
                                            {(PROVIDER_NAMES[config.provider_type] || "?").charAt(0).toUpperCase()}
                                        </div>
                                        <div className="ai-provider-card-main">
                                            <div className="ai-provider-card-name">
                                                {config.name || PROVIDER_NAMES[config.provider_type] || "Unnamed"}
                                            </div>
                                            <div className="ai-provider-card-model">
                                                {config.model || "No model selected"}
                                            </div>
                                            <div className="ai-provider-card-badges">
                                                <span className={`ai-provider-dot ${config.is_enabled ? "is-on" : "is-off"}`} aria-hidden="true" />
                                                <span className="ai-provider-card-status">
                                                    {config.is_enabled ? "Enabled" : "Disabled"}
                                                </span>
                                                {config.is_enabled && config.is_primary && (
                                                    <span className="ai-provider-badge ai-provider-badge-inuse">In use</span>
                                                )}
                                            </div>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </aside>

                    {/* Main Content */}
                    <section className="ai-settings-content">
                        <div className="ai-settings-local-card">
                            <div className="ai-settings-local-copy">
                                <span className="ai-settings-local-kicker">LOCAL AI QUICK SETUP</span>
                                <h3 className="ai-settings-local-title">Ollama + Gemma 4 E2B on this machine</h3>
                                <p className="ai-settings-local-description">
                                    One click will install Ollama if needed, download <code>gemma4:e2b</code> locally,
                                    and switch TableR to use that model first for workspace AI.
                                </p>
                                <div className="ai-settings-local-badges">
                                    <span className="ai-settings-chip">
                                        {isLoadingLocalOllamaStatus
                                            ? "Checking local status..."
                                            : localOllamaStatus?.isInstalled
                                                ? "Ollama installed"
                                                : "Ollama missing"}
                                    </span>
                                    <span className="ai-settings-chip">
                                        {localOllamaStatus?.isRunning ? "Service running" : "Service offline"}
                                    </span>
                                    <span className="ai-settings-chip">
                                        {localOllamaStatus?.hasRecommendedModel ? "Model ready" : "Model not downloaded"}
                                    </span>
                                    <span className="ai-settings-chip">{localOllamaPrimaryText}</span>
                                </div>
                                <div className="ai-settings-local-meta">
                                    <span>Model size: ~7.2 GB</span>
                                    {localOllamaStatus?.version && <span>Ollama {localOllamaStatus.version}</span>}
                                    <span>Endpoint: {localOllamaStatus?.endpoint || "http://localhost:11434/v1/chat/completions"}</span>
                                </div>
                                {localOllamaStatusError && (
                                    <div className="ai-settings-local-inline-error">{localOllamaStatusError}</div>
                                )}
                            </div>
                            <div className="ai-settings-local-actions">
                                <button
                                    type="button"
                                    className="ai-settings-btn-quick-setup"
                                    onClick={() => {
                                        setShowLocalOllamaConsent(true);
                                        setLocalOllamaConsentNotice(null);
                                        setLocalOllamaConsentTone("info");
                                    }}
                                    disabled={isSettingUpLocalOllama || localOllamaStatus?.supported === false}
                                >
                                    {isSettingUpLocalOllama ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                        <Download className="w-4 h-4" />
                                    )}
                                    <span>{localOllamaButtonLabel}</span>
                                </button>
                                <button
                                    type="button"
                                    className="ai-settings-btn-check"
                                    onClick={() => void refreshLocalOllamaStatus()}
                                    disabled={isLoadingLocalOllamaStatus || isSettingUpLocalOllama}
                                >
                                    {isLoadingLocalOllamaStatus ? "Refreshing..." : "Refresh status"}
                                </button>
                                <div className="ai-settings-local-progress">
                                    <div className="ai-settings-progress-meta">
                                        <span>{isSettingUpLocalOllama ? localOllamaProgress.message : "Windows setup uses the official Ollama installer."}</span>
                                        <strong>{localOllamaProgressLabel}</strong>
                                    </div>
                                    <div className="ai-settings-progress-track">
                                        <div
                                            className={`ai-settings-progress-fill ${localOllamaProgress.isEstimated ? "is-estimated" : ""}`}
                                            style={{ width: localOllamaProgressWidth }}
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Workspace AI Card */}
                        {activeConfig && (
                            <div className="ai-settings-workspace-card">
                                <div className="ai-settings-workspace-info">
                                    <div className="ai-settings-workspace-icon">
                                        <Sparkles className="w-5 h-5" />
                                    </div>
                                    <div className="ai-settings-workspace-text">
                                        <span className="ai-settings-workspace-label">WORKSPACE AI</span>
                                        <strong>{activeConfig.name || PROVIDER_NAMES[activeConfig.provider_type]}</strong>
                                        <p className="ai-settings-workspace-desc">
                                            {PROVIDER_NAMES[activeConfig.provider_type]} {activeConfig.model && `| ${activeConfig.model}`}
                                        </p>
                                    </div>
                                </div>
                                <div className="ai-settings-workspace-chips">
                                    <span className="ai-settings-chip">{PROVIDER_NAMES[activeConfig.provider_type]}</span>
                                    <span className="ai-settings-chip">{activeConfig.model || "No model"}</span>
                                    {activeConfig.allow_schema_context && (
                                        <span className="ai-settings-chip">Schema sharing on</span>
                                    )}
                                </div>
                                <div className="ai-settings-workspace-actions">
                                    <span className={connectionStatusClass} title={connectionCheckMessage || undefined}>
                                        {connectionStatusLabel}
                                    </span>
                                    <button type="button" onClick={handleCheckConnection} className="ai-settings-btn-check" disabled={connectionCheckStatus === "checking" || disableModalActions}>
                                        {connectionCheckStatus === "checking" ? "Checking..." : "Check connection"}
                                    </button>
                                    {!isActiveProviderInUse && (
                                        <button
                                            type="button"
                                            onClick={() => setPrimaryProvider(activeConfig.id)}
                                            className="ai-settings-btn-use"
                                            disabled={isSettingUpLocalOllama}
                                        >
                                            Use for AI
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => handleDelete(activeConfig.id)}
                                        className="ai-settings-btn-delete"
                                        title="Delete Provider"
                                        disabled={isSettingUpLocalOllama}
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Provider Configuration Panels */}
                        {activeConfig && (
                            <div className="ai-settings-panels">
                                {/* Identity Panel */}
                                <div className="ai-settings-panel">
                                    <h4 className="ai-settings-panel-title">Identity</h4>
                                    <div className="ai-settings-fields">
                                        <div className="ai-settings-field">
                                            <label className="ai-settings-label">Provider</label>
                                            <div className="ai-settings-select-shell" ref={providerMenuRef}>
                                                <button
                                                    type="button"
                                                    className="ai-settings-select-trigger"
                                                    onClick={() => setIsProviderMenuOpen((prev) => !prev)}
                                                    disabled={isSettingUpLocalOllama}
                                                >
                                                    <span>{PROVIDER_NAMES[activeConfig.provider_type] || "Select provider"}</span>
                                                    <span className="ai-settings-select-caret" />
                                                </button>
                                                {isProviderMenuOpen && (
                                                    <div className="ai-settings-select-menu">
                                                        {Object.entries(PROVIDER_NAMES).map(([value, label]) => (
                                                            <button
                                                                key={value}
                                                                type="button"
                                                                className={`ai-settings-select-option ${activeConfig.provider_type === value ? "active" : ""}`}
                                                                onClick={() => {
                                                                    updateConfig(activeConfig.id, { provider_type: value as AIProviderConfig["provider_type"] });
                                                                    setIsProviderMenuOpen(false);
                                                                }}
                                                            >
                                                                {label}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                        <div className="ai-settings-field">
                                            <label className="ai-settings-label">Name</label>
                                            <input
                                                type="text"
                                                value={activeConfig.name}
                                                onChange={(e) => updateConfig(activeConfig.id, { name: e.target.value })}
                                                className="ai-settings-input"
                                                disabled={isSettingUpLocalOllama}
                                            />
                                        </div>
                                        <div className="ai-settings-field">
                                            <label className="ai-settings-label">Model Name</label>
                                            <input
                                                type="text"
                                                value={activeConfig.model}
                                                onChange={(e) => updateConfig(activeConfig.id, { model: e.target.value })}
                                                placeholder="e.g. gpt-4o-mini"
                                                className="ai-settings-input"
                                                disabled={isSettingUpLocalOllama}
                                            />
                                        </div>
                                        <div className="ai-settings-field">
                                            <label className="ai-settings-label">
                                                {activeConfig.provider_type === "ollama" || activeConfig.provider_type === "custom"
                                                    ? "API Key (optional)"
                                                    : "API Key"}
                                            </label>
                                            <input
                                                type="password"
                                                value={keyDrafts[activeConfig.id] || ""}
                                                onChange={(e) => handleKeyDraftChange(activeConfig.id, e.target.value)}
                                                placeholder={
                                                    hasStoredKey
                                                        ? "Stored securely - enter new key to replace"
                                                        : activeConfig.provider_type === "ollama"
                                                            ? "Leave blank for local Ollama"
                                                            : "sk-..."
                                                }
                                                className="ai-settings-input ai-settings-input-mono"
                                                disabled={isSettingUpLocalOllama}
                                            />
                                            {hasStoredKey && (
                                                <button
                                                    type="button"
                                                    onClick={() => handleClearStoredKey(activeConfig.id)}
                                                    className="ai-settings-btn-clear"
                                                    disabled={isSettingUpLocalOllama}
                                                >
                                                    Clear Stored Key
                                                </button>
                                            )}
                                        </div>
                                        <div className="ai-settings-field">
                                            <label className="ai-settings-label">{endpointFieldCopy?.label || "Custom URL"}</label>
                                            <input
                                                type="text"
                                                value={activeConfig.endpoint}
                                                onChange={(e) => updateConfig(activeConfig.id, { endpoint: e.target.value })}
                                                placeholder={endpointFieldCopy?.placeholder || ""}
                                                className="ai-settings-input ai-settings-input-mono"
                                                disabled={isSettingUpLocalOllama}
                                            />
                                            {endpointFieldCopy?.hint && (
                                                <p className="ai-settings-field-hint">{endpointFieldCopy.hint}</p>
                                            )}
                                            {activeConfig.provider_type !== "custom" && activeConfig.endpoint.trim().length > 0 && (
                                                <button
                                                    type="button"
                                                    onClick={() => updateConfig(activeConfig.id, { endpoint: "" })}
                                                    className="ai-settings-btn-clear"
                                                    disabled={isSettingUpLocalOllama}
                                                >
                                                    Use Default URL
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Access Panel */}
                                <div className="ai-settings-panel">
                                    <h4 className="ai-settings-panel-title">Workspace Access</h4>
                                    <div className="ai-settings-toggles">
                                        <div className="ai-settings-toggle-row">
                                            <div className="ai-settings-toggle-info">
                                                <span className="ai-settings-toggle-label">Enable this provider</span>
                                                <p>Allow AI chat and auto-completion</p>
                                            </div>
                                            <label className="ai-settings-toggle-switch">
                                                <input
                                                    type="checkbox"
                                                    checked={activeConfig.is_enabled}
                                                    onChange={(e) => updateConfig(activeConfig.id, {
                                                        is_enabled: e.target.checked,
                                                        is_primary: e.target.checked ? activeConfig.is_primary : false,
                                                    })}
                                                    disabled={isSettingUpLocalOllama}
                                                />
                                                <span className="ai-settings-toggle-slider" />
                                            </label>
                                        </div>
                                        <div className="ai-settings-toggle-row">
                                            <div className="ai-settings-toggle-info">
                                                <span className="ai-settings-toggle-label">Schema context sharing</span>
                                                <p>Include database context in AI requests</p>
                                            </div>
                                            <label className="ai-settings-toggle-switch">
                                                <input
                                                    type="checkbox"
                                                    checked={activeConfig.allow_schema_context}
                                                    onChange={(e) => updateConfig(activeConfig.id, { allow_schema_context: e.target.checked })}
                                                    disabled={isSettingUpLocalOllama}
                                                />
                                                <span className="ai-settings-toggle-slider" />
                                            </label>
                                        </div>
                                        <div className="ai-settings-toggle-row">
                                            <div className="ai-settings-toggle-info">
                                                <span className="ai-settings-toggle-label">Inline completion</span>
                                                <p>AI suggestions while typing SQL</p>
                                            </div>
                                            <label className="ai-settings-toggle-switch">
                                                <input
                                                    type="checkbox"
                                                    checked={activeConfig.allow_inline_completion}
                                                    onChange={(e) => updateConfig(activeConfig.id, { allow_inline_completion: e.target.checked })}
                                                    disabled={isSettingUpLocalOllama}
                                                />
                                                <span className="ai-settings-toggle-slider" />
                                            </label>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {!activeConfig && configs.length > 0 && (
                            <div className="ai-settings-empty-state">
                                <Brain className="w-12 h-12" />
                                <h3>Select a provider</h3>
                                <p>Pick one from the left to edit it.</p>
                            </div>
                        )}
                    </section>
                </div>

                {showLocalOllamaConsent && (
                    <div className="ai-settings-consent-backdrop">
                        <div className="ai-settings-consent-dialog">
                            <div className="ai-settings-consent-copy">
                                <span className="ai-settings-local-kicker">CONFIRM LOCAL INSTALL</span>
                                <h3 className="ai-settings-consent-title">Set up Ollama + Gemma 4 E2B now?</h3>
                                <p className="ai-settings-consent-description">
                                    TableR will use the official Ollama installer for Windows, start the local service,
                                    download <code>gemma4:e2b</code> to this machine, and switch the app to that local model.
                                </p>
                                <div className="ai-settings-consent-list">
                                    <div className="ai-settings-consent-item">Downloads roughly 7.2 GB for the model.</div>
                                    {localOllamaStatus?.version && (
                                        <div className="ai-settings-consent-item">Current Ollama version detected: <code>{localOllamaStatus.version}</code>.</div>
                                    )}
                                    <div className="ai-settings-consent-item">Keeps inference local at <code>localhost:11434</code>.</div>
                                    <div className="ai-settings-consent-item">Makes the Ollama provider active in TableR after setup.</div>
                                </div>
                                <div className={`ai-settings-consent-progress ai-settings-consent-progress-${localOllamaConsentTone}`}>
                                    <div className="ai-settings-progress-meta">
                                        <span>
                                            {isSettingUpLocalOllama
                                                ? localOllamaProgress.message
                                                : localOllamaConsentNotice || "Windows may ask for permission while Ollama installs."}
                                        </span>
                                        <strong>{localOllamaProgressLabel}</strong>
                                    </div>
                                    <div className="ai-settings-progress-track">
                                        <div
                                            className={`ai-settings-progress-fill ${localOllamaProgress.isEstimated ? "is-estimated" : ""}`}
                                            style={{ width: localOllamaProgressWidth }}
                                        />
                                    </div>
                                </div>
                            </div>
                            <div className="ai-settings-consent-actions">
                                <button
                                    type="button"
                                    className="ai-settings-btn-cancel"
                                    onClick={() => {
                                        setShowLocalOllamaConsent(false);
                                        setLocalOllamaConsentNotice(null);
                                        setLocalOllamaConsentTone("info");
                                    }}
                                    disabled={isSettingUpLocalOllama}
                                >
                                    {localOllamaConsentTone === "success" ? "Close" : "Not now"}
                                </button>
                                <button
                                    type="button"
                                    className="ai-settings-btn-quick-setup"
                                    onClick={() => {
                                        if (localOllamaConsentTone === "success" && !isSettingUpLocalOllama) {
                                            setShowLocalOllamaConsent(false);
                                            setLocalOllamaConsentNotice(null);
                                            setLocalOllamaConsentTone("info");
                                            return;
                                        }
                                        void handleSetupLocalOllama();
                                    }}
                                    disabled={isSettingUpLocalOllama}
                                >
                                    {isSettingUpLocalOllama ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : localOllamaConsentTone === "success" ? (
                                        <Check className="w-4 h-4" />
                                    ) : (
                                        <Download className="w-4 h-4" />
                                    )}
                                    <span>
                                        {isSettingUpLocalOllama
                                            ? "Installing..."
                                            : localOllamaConsentTone === "success"
                                                ? "Done"
                                                : "Install and use locally"}
                                    </span>
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}







