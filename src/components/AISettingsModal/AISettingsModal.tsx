import { useState, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Plus, Trash2, Brain, Loader2, Check, Download, Pencil, Lock, X } from "lucide-react";
import { useAIStore } from "../../stores/aiStore";
import { invokeWithTimeout } from "../../utils/tauri-utils";
import { getCurrentAppLanguage } from "../../i18n";
import type { AIProviderConfig, LocalOllamaSetupProgressEvent, LocalOllamaStatus } from "../../types";
import {
    AI_PROVIDER_TYPES,
    formatAIProviderTypeLabel,
    getAIProviderEndpointFieldCopy,
    normalizeAIProviderConfigs,
} from "../../utils/ai-provider-registry";

const LOCAL_OLLAMA_EVENT = "ollama-setup-progress";

interface Props {
    onClose: () => void;
}

export function AISettingsModal({ onClose }: Props) {
    const saveAIConfigs = useAIStore((state) => state.saveAIConfigs);
    const loadAIConfigs = useAIStore((state) => state.loadAIConfigs);
    const getLocalOllamaStatus = useAIStore((state) => state.getLocalOllamaStatus);
    const setupLocalOllama = useAIStore((state) => state.setupLocalOllama);

    const [configs, setConfigs] = useState<AIProviderConfig[]>([]);
    const [storedKeyStatus, setStoredKeyStatus] = useState<Record<string, boolean>>({});
    const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
    const [clearedKeyIds, setClearedKeyIds] = useState<string[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [modelDialog, setModelDialog] = useState<{
        index: number;
        value: string;
        contextWindow: string;
        maxOutputTokens: string;
        inputTypes: string[];
        outputTypes: string[];
    } | null>(null);
    const [modelDialogError, setModelDialogError] = useState<string | null>(null);
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
    const [isLocalSelected, setIsLocalSelected] = useState(false);
    const [isEditingName, setIsEditingName] = useState(false);

    useEffect(() => {
        let isMounted = true;

        loadAIConfigs()
            .then(({ aiConfigs, aiKeyStatus }) => {
                if (!isMounted) return;

                setConfigs(normalizeAIProviderConfigs(aiConfigs));
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
        setConfigs((current) => normalizeAIProviderConfigs([...current, {
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
        const remainingConfigs = normalizeAIProviderConfigs(configs.filter((c) => c.id !== id));
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

    const handleDeleteModel = (index: number) => {
        if (!activeConfig) return;
        const models = [...activeConfigModels];
        const removed = models.splice(index, 1)[0];
        if (removed === undefined) return;
        // Removing the active model promotes the first remaining one so the
        // provider never points at a model that no longer exists.
        const nextModel = activeConfig.model === removed ? (models[0] ?? "") : activeConfig.model;
        const modelSettings = { ...(activeConfig.model_settings ?? {}) };
        delete modelSettings[removed];
        updateConfig(activeConfig.id, {
            models,
            model: nextModel,
            disabled_models: (activeConfig.disabled_models ?? []).filter((entry) => entry !== removed),
            model_settings: modelSettings,
        });
    };

    const handleToggleModelDisabled = (index: number) => {
        if (!activeConfig) return;
        const modelName = activeConfigModels[index];
        if (!modelName) return;
        const disabled = new Set(activeConfig.disabled_models ?? []);
        const isDisabling = !disabled.has(modelName);
        if (isDisabling) {
            disabled.add(modelName);
        } else {
            disabled.delete(modelName);
        }
        // Disabling the active model promotes the first model that stays enabled.
        let nextModel = activeConfig.model;
        if (isDisabling && activeConfig.model === modelName) {
            nextModel = activeConfigModels.find((entry) => entry !== modelName && !disabled.has(entry)) ?? "";
        }
        updateConfig(activeConfig.id, { disabled_models: [...disabled], model: nextModel });
    };

    const handleSaveModelDialog = () => {
        if (!activeConfig || !modelDialog) return;
        const value = modelDialog.value.trim();
        if (!value) {
            setModelDialogError("Model ID cannot be empty.");
            return;
        }
        const duplicateIndex = activeConfigModels.findIndex(
            (entry, entryIndex) => entryIndex !== modelDialog.index && entry.toLowerCase() === value.toLowerCase(),
        );
        if (duplicateIndex !== -1) {
            setModelDialogError("That model ID already exists for this provider.");
            return;
        }
        const models = [...activeConfigModels];
        const wasActiveModel = modelDialog.index >= 0 && models[modelDialog.index] === activeConfig.model;
        const previousName = modelDialog.index >= 0 ? models[modelDialog.index] : undefined;
        if (modelDialog.index >= 0) {
            models[modelDialog.index] = value;
        } else {
            models.push(value);
        }
        // Keep the disabled list pointing at the renamed entry.
        const disabledModels = (activeConfig.disabled_models ?? []).map(
            (entry) => (previousName && entry === previousName ? value : entry),
        );
        // A brand-new first model, or a rename of the active model, keeps the
        // provider pointing at something that exists.
        const nextModel = wasActiveModel || !activeConfig.model?.trim() ? value : activeConfig.model;
        // Persist per-model settings; renaming remaps the settings key.
        const modelSettings = { ...(activeConfig.model_settings ?? {}) };
        if (modelDialog.index >= 0 && previousName && previousName !== value) {
            delete modelSettings[previousName];
        }
        const parseCount = (raw: string): number | null => {
            const parsed = Number(raw.replace(/[_,\s]/g, ""));
            return raw.trim() && Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
        };
        modelSettings[value] = {
            context_window: parseCount(modelDialog.contextWindow),
            max_output_tokens: parseCount(modelDialog.maxOutputTokens),
            input_types: modelDialog.inputTypes.length > 0 ? modelDialog.inputTypes : ["text"],
            output_types: modelDialog.outputTypes.length > 0 ? modelDialog.outputTypes : ["text"],
        };
        updateConfig(activeConfig.id, { models, model: nextModel, disabled_models: disabledModels, model_settings: modelSettings });
        setModelDialog(null);
        setModelDialogError(null);
    };

    const handleSave = async () => {
        const apiKeyUpdates = Object.fromEntries(
            Object.entries(keyDrafts).filter(([, value]) => value.trim().length > 0)
        );
        setIsSaving(true);
        setSaveError(null);
        try {
            const { aiConfigs, aiKeyStatus } = await saveAIConfigs(configs, apiKeyUpdates, clearedKeyIds);
            setConfigs(normalizeAIProviderConfigs(aiConfigs));
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
            setConfigs(normalizeAIProviderConfigs(aiConfigs));
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
        setConfigs((current) => normalizeAIProviderConfigs(current.map((config) => {
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
        setConfigs((current) => normalizeAIProviderConfigs(current.map((config) => (
            config.id === id
                ? { ...config, is_enabled: true, is_primary: true }
                : { ...config, is_primary: false }
        ))));
    };

    const activeConfig = configs.find(c => c.id === editingId);
    const activeConfigModels = activeConfig
        ? (activeConfig.models?.length
            ? activeConfig.models
            : (activeConfig.model?.trim() ? [activeConfig.model.trim()] : []))
        : [];
    const endpointFieldCopy = activeConfig ? getAIProviderEndpointFieldCopy(activeConfig) : null;
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
            setConfigs(normalizeAIProviderConfigs(result.aiConfigs));
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
                    {/* Provider list (master pane) */}
                    <aside className="ai-settings-sidebar">
                        <div className="ai-settings-sidebar-group-label">Providers</div>
                        <div className="ai-settings-sidebar-list">
                            {configs.map((config) => (
                                <button
                                    key={config.id}
                                    type="button"
                                    onClick={() => {
                                        setEditingId(config.id);
                                        setIsLocalSelected(false);
                                        setIsEditingName(false);
                                    }}
                                    className={`ai-settings-sidebar-item ${!isLocalSelected && editingId === config.id ? "active" : ""}`}
                                    disabled={isSettingUpLocalOllama}
                                >
                                    <span className="ai-settings-sidebar-item-icon" aria-hidden="true">
                                        {formatAIProviderTypeLabel(config.provider_type).charAt(0).toUpperCase()}
                                    </span>
                                    <span className="ai-settings-sidebar-item-name">
                                        {config.name || formatAIProviderTypeLabel(config.provider_type) || "Unnamed"}
                                    </span>
                                    <span
                                        className={`ai-provider-dot ${config.is_enabled ? "is-on" : "is-off"}`}
                                        title={config.is_enabled ? "Enabled" : "Disabled"}
                                    />
                                </button>
                            ))}
                        </div>

                        <div className="ai-settings-sidebar-group-label">Local</div>
                        <button
                            type="button"
                            onClick={() => {
                                setIsLocalSelected(true);
                                setIsEditingName(false);
                            }}
                            className={`ai-settings-sidebar-item ${isLocalSelected ? "active" : ""}`}
                            disabled={isSettingUpLocalOllama}
                        >
                            <Download className="w-4 h-4" />
                            <span className="ai-settings-sidebar-item-name">Local AI setup</span>
                        </button>

                        <button
                            type="button"
                            onClick={handleAdd}
                            className="ai-settings-sidebar-item ai-settings-sidebar-add"
                            disabled={isSettingUpLocalOllama}
                        >
                            <Plus className="w-4 h-4" />
                            <span className="ai-settings-sidebar-item-name">Add provider</span>
                        </button>
                    </aside>

                    {/* Detail pane */}
                    <section className="ai-settings-detail">
                        {isLocalSelected ? (
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
                        ) : configs.length === 0 ? (
                            <div className="ai-settings-empty">
                                <Brain className="w-10 h-10" />
                                <h4>No providers yet</h4>
                                <p>Add your first model provider to enable AI chat.</p>
                                <button type="button" onClick={handleAdd} className="ai-settings-btn-primary" disabled={isSettingUpLocalOllama}>
                                    <Plus className="w-4 h-4" />
                                    <span>Create Provider</span>
                                </button>
                            </div>
                        ) : !activeConfig ? null : (
                            <>
                                {/* Detail header */}
                                <header className="ai-settings-detail-header">
                                    {isEditingName ? (
                                        <input
                                            type="text"
                                            autoFocus
                                            value={activeConfig.name}
                                            onChange={(e) => updateConfig(activeConfig.id, { name: e.target.value })}
                                            onBlur={() => setIsEditingName(false)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter" || e.key === "Escape") setIsEditingName(false);
                                            }}
                                            className="ai-settings-input ai-settings-detail-name-input"
                                            disabled={isSettingUpLocalOllama}
                                        />
                                    ) : (
                                        <h3 className="ai-settings-detail-title" title={activeConfig.name}>
                                            {activeConfig.name || formatAIProviderTypeLabel(activeConfig.provider_type) || "Unnamed"}
                                        </h3>
                                    )}
                                    <button
                                        type="button"
                                        className="ai-settings-icon-btn"
                                        onClick={() => setIsEditingName((prev) => !prev)}
                                        title="Rename"
                                        disabled={isSettingUpLocalOllama}
                                    >
                                        <Pencil className="w-3.5 h-3.5" />
                                    </button>
                                    <span className={`ai-settings-status-pill ${activeConfig.is_enabled ? "is-on" : "is-off"}`}>
                                        {activeConfig.is_enabled ? "Enabled" : "Disabled"}
                                    </span>
                                    <button
                                        type="button"
                                        className="ai-settings-btn-toggle"
                                        onClick={() => updateConfig(activeConfig.id, {
                                            is_enabled: !activeConfig.is_enabled,
                                            is_primary: !activeConfig.is_enabled ? activeConfig.is_primary : false,
                                        })}
                                        disabled={isSettingUpLocalOllama}
                                    >
                                        {activeConfig.is_enabled ? "Disable" : "Enable"}
                                    </button>
                                    <button
                                        type="button"
                                        className="ai-settings-icon-btn ai-settings-icon-btn-danger"
                                        onClick={() => handleDelete(activeConfig.id)}
                                        title="Delete Provider"
                                        disabled={isSettingUpLocalOllama}
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </header>
                                {/* Connection */}
                                <div className="ai-settings-section">
                                    <div className="ai-settings-section-label">Connection</div>
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
                                                    <span>{formatAIProviderTypeLabel(activeConfig.provider_type) || "Select provider"}</span>
                                                    <span className="ai-settings-select-caret" />
                                                </button>
                                                {isProviderMenuOpen && (
                                                    <div className="ai-settings-select-menu">
                                                        {AI_PROVIDER_TYPES.map((value) => (
                                                            <button
                                                                key={value}
                                                                type="button"
                                                                className={`ai-settings-select-option ${activeConfig.provider_type === value ? "active" : ""}`}
                                                                onClick={() => {
                                                                    updateConfig(activeConfig.id, { provider_type: value as AIProviderConfig["provider_type"] });
                                                                    setIsProviderMenuOpen(false);
                                                                }}
                                                            >
                                                                {formatAIProviderTypeLabel(value)}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                        <div className="ai-settings-field">
                                            <label className="ai-settings-label">Models</label>
                                            <div className="ai-settings-model-list">
                                                {activeConfigModels.length > 0 ? activeConfigModels.map((modelName, index) => {
                                                    const isModelDisabled = (activeConfig.disabled_models ?? []).includes(modelName);
                                                    return (
                                                    <div key={`${modelName}-${index}`} className={`ai-settings-model-row ${isModelDisabled ? "is-disabled" : ""}`}>
                                                        <span className={`ai-settings-model-name ${modelName === activeConfig.model ? "is-active" : ""}`}>{modelName}</span>
                                                        {isModelDisabled ? <span className="ai-settings-model-inactive">Disabled</span> : null}
                                                        {modelName === activeConfig.model && !isModelDisabled ? <span className="ai-settings-model-active">Active</span> : null}
                                                        <button
                                                            type="button"
                                                            className="ai-settings-model-state-btn"
                                                            title={isModelDisabled ? "Enable model" : "Disable model"}
                                                            disabled={isSettingUpLocalOllama}
                                                            onClick={() => handleToggleModelDisabled(index)}
                                                        >
                                                            {isModelDisabled ? "Enable" : "Disable"}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="ai-settings-icon-btn"
                                                            title="Edit model"
                                                            disabled={isSettingUpLocalOllama}
                                                            onClick={() => {
                                                                const existing = activeConfig?.model_settings?.[modelName];
                                                                setModelDialog({
                                                                    index,
                                                                    value: modelName,
                                                                    contextWindow: existing?.context_window != null ? String(existing.context_window) : "",
                                                                    maxOutputTokens: existing?.max_output_tokens != null ? String(existing.max_output_tokens) : "",
                                                                    inputTypes: existing?.input_types ?? ["text"],
                                                                    outputTypes: existing?.output_types ?? ["text"],
                                                                });
                                                            }}
                                                        >
                                                            <Pencil className="w-3.5 h-3.5" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="ai-settings-icon-btn ai-settings-icon-btn-danger"
                                                            title="Delete model"
                                                            disabled={isSettingUpLocalOllama}
                                                            onClick={() => handleDeleteModel(index)}
                                                        >
                                                            <Trash2 className="w-4 h-4" />
                                                        </button>
                                                    </div>
                                                    );
                                                }) : (
                                                    <p className="ai-settings-model-empty">No models yet — add one below.</p>
                                                )}
                                                <button
                                                    type="button"
                                                    className="ai-settings-btn-toggle"
                                                    disabled={isSettingUpLocalOllama}
                                                    onClick={() => setModelDialog({ index: -1, value: "", contextWindow: "", maxOutputTokens: "", inputTypes: ["text"], outputTypes: ["text"] })}
                                                >
                                                    + Add model
                                                </button>
                                            </div>
                                        </div>
                                        {activeConfig.provider_type === "custom" ? (
                                            <div className="ai-settings-field">
                                                <label className="ai-settings-label">API format</label>
                                                <select
                                                    className="ai-settings-input"
                                                    value={activeConfig.api_format || "auto"}
                                                    onChange={(e) => updateConfig(activeConfig.id, { api_format: e.target.value === "auto" ? null : e.target.value })}
                                                    disabled={isSettingUpLocalOllama}
                                                >
                                                    <option value="auto">Auto-detect from URL</option>
                                                    <option value="chat-completions">Chat completions (/chat/completions)</option>
                                                    <option value="ollama-chat">Ollama /api/chat</option>
                                                    <option value="ollama-generate">Ollama /api/generate</option>
                                                </select>
                                            </div>
                                        ) : null}
                                        {modelDialog ? (
                                            <div className="ai-settings-model-dialog-backdrop" role="dialog" aria-label="Edit model settings">
                                                <div className="ai-settings-model-dialog">
                                                    <div className="ai-settings-model-dialog-head">
                                                        <span className="ai-settings-model-dialog-title">
                                                            {modelDialog.index >= 0 ? "Edit model settings" : "Add model"}
                                                        </span>
                                                        <button
                                                            type="button"
                                                            className="ai-settings-icon-btn"
                                                            title="Close"
                                                            onClick={() => setModelDialog(null)}
                                                        >
                                                            <X className="w-4 h-4" />
                                                        </button>
                                                    </div>
                                                    <label className="ai-settings-label">Model ID</label>
                                                    <input
                                                        autoFocus
                                                        type="text"
                                                        className="ai-settings-input"
                                                        value={modelDialog.value}
                                                        onChange={(e) => setModelDialog({ ...modelDialog, value: e.target.value })}
                                                        placeholder="e.g. deepseek-v4-flash"
                                                    />
                                                    <label className="ai-settings-label">Context window</label>
                                                    <input
                                                        type="text"
                                                        inputMode="numeric"
                                                        className="ai-settings-input"
                                                        value={modelDialog.contextWindow}
                                                        onChange={(e) => setModelDialog({ ...modelDialog, contextWindow: e.target.value })}
                                                        placeholder="e.g. 1000000 (tokens)"
                                                    />
                                                    <label className="ai-settings-label">Max output tokens</label>
                                                    <input
                                                        type="text"
                                                        inputMode="numeric"
                                                        className="ai-settings-input"
                                                        value={modelDialog.maxOutputTokens}
                                                        onChange={(e) => setModelDialog({ ...modelDialog, maxOutputTokens: e.target.value })}
                                                        placeholder="e.g. 128000 (tokens)"
                                                    />
                                                    <label className="ai-settings-label">Input types</label>
                                                    <div className="ai-settings-type-chips">
                                                        {(["text", "image", "video"] as const).map((type) => {
                                                            const isLocked = type === "text";
                                                            const checked = isLocked || modelDialog.inputTypes.includes(type);
                                                            return (
                                                                <button
                                                                    key={type}
                                                                    type="button"
                                                                    className={`ai-settings-type-chip ${checked ? "is-on" : ""}`}
                                                                    disabled={isLocked}
                                                                    title={isLocked ? "Text input is always supported" : undefined}
                                                                    onClick={() => setModelDialog({
                                                                        ...modelDialog,
                                                                        inputTypes: checked
                                                                            ? modelDialog.inputTypes.filter((entry) => entry !== type)
                                                                            : [...modelDialog.inputTypes, type],
                                                                    })}
                                                                >
                                                                    <span className="ai-settings-type-check">{checked ? <Check className="w-3 h-3" /> : null}</span>
                                                                    {type.charAt(0).toUpperCase() + type.slice(1)}
                                                                    {isLocked ? <Lock className="w-3 h-3" /> : null}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                    <label className="ai-settings-label">Output types</label>
                                                    <div className="ai-settings-type-chips">
                                                        {(["text", "image", "video"] as const).map((type) => {
                                                            const isLocked = type === "text";
                                                            const checked = isLocked || modelDialog.outputTypes.includes(type);
                                                            return (
                                                                <button
                                                                    key={type}
                                                                    type="button"
                                                                    className={`ai-settings-type-chip ${checked ? "is-on" : ""}`}
                                                                    disabled={isLocked}
                                                                    title={isLocked ? "Text output is always supported" : undefined}
                                                                    onClick={() => setModelDialog({
                                                                        ...modelDialog,
                                                                        outputTypes: checked
                                                                            ? modelDialog.outputTypes.filter((entry) => entry !== type)
                                                                            : [...modelDialog.outputTypes, type],
                                                                    })}
                                                                >
                                                                    <span className="ai-settings-type-check">{checked ? <Check className="w-3 h-3" /> : null}</span>
                                                                    {type.charAt(0).toUpperCase() + type.slice(1)}
                                                                    {isLocked ? <Lock className="w-3 h-3" /> : null}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                    {modelDialogError ? <div className="ai-settings-error">{modelDialogError}</div> : null}
                                                    <div className="ai-settings-model-dialog-actions">
                                                        <button type="button" className="ai-settings-btn-cancel" onClick={() => setModelDialog(null)}>Cancel</button>
                                                        <button type="button" className="ai-settings-btn-save" onClick={handleSaveModelDialog}>Save</button>
                                                    </div>
                                                </div>
                                            </div>
                                        ) : null}
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
                                {/* Workspace */}
                                <div className="ai-settings-section">
                                    <div className="ai-settings-section-label">Workspace</div>
                                    <div className="ai-settings-primary-row">
                                        <span className={connectionStatusClass} title={connectionCheckMessage || undefined}>
                                            {connectionStatusLabel}
                                        </span>
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
                                            onClick={handleCheckConnection}
                                            className="ai-settings-btn-check"
                                            disabled={connectionCheckStatus === "checking" || disableModalActions}
                                        >
                                            {connectionCheckStatus === "checking" ? "Checking..." : "Check connection"}
                                        </button>
                                    </div>
                                    {connectionCheckMessage && connectionCheckStatus !== "idle" && (
                                        <p className={`ai-settings-check-message ${connectionCheckStatus}`}>
                                            {connectionCheckMessage}
                                        </p>
                                    )}
                                    <p className="ai-settings-field-hint">
                                        "Use for AI" makes this provider the active assistant for chat and SQL completion.
                                    </p>
                                </div>
                                {/* Access */}
                                <div className="ai-settings-section">
                                    <div className="ai-settings-section-label">Access</div>
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
                            </>
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







