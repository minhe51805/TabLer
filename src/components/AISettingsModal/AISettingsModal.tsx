import { useState, useEffect } from "react";
import { Plus, Trash2, Cpu, Brain, Edit2, KeyRound, Sparkles, Link2, Loader2 } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import type { AIProviderConfig, AIProviderType } from "../../types";

const PROVIDER_NAMES: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Claude",
    gemini: "Gemini",
    openrouter: "OpenRouter",
    ollama: "Ollama",
    custom: "Custom",
};

interface Props {
    onClose: () => void;
}

const PROVIDER_HINTS: Record<AIProviderType, string> = {
    openai: "Best for GPT models and general purpose completions.",
    anthropic: "Claude models with strong reasoning and long context.",
    gemini: "Google-hosted models for multi-purpose assistance.",
    openrouter: "Route requests across many hosted model providers.",
    ollama: "Run local models without sending data to the cloud.",
    custom: "Connect your own OpenAI-compatible endpoint.",
};

const DEFAULT_PROVIDER_ENDPOINTS: Partial<Record<AIProviderType, string>> = {
    openai: "https://api.openai.com/v1/chat/completions",
    anthropic: "https://api.anthropic.com/v1/messages",
    gemini: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
    ollama: "http://localhost:11434/v1/chat/completions",
};

const PROVIDER_OPTIONS: Array<{ value: AIProviderType; label: string; meta: string }> = [
    { value: "openai", label: "OpenAI", meta: "GPT models and broad general-purpose tasks." },
    { value: "anthropic", label: "Claude", meta: "Long-form reasoning and careful explanations." },
    { value: "openrouter", label: "OpenRouter", meta: "Switch between many hosted backends." },
    { value: "ollama", label: "Ollama", meta: "Local models with your own runtime." },
    { value: "gemini", label: "Gemini", meta: "Google-hosted multi-purpose assistance." },
    { value: "custom", label: "Custom", meta: "Any OpenAI-compatible endpoint you control." },
];

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

export function AISettingsModal({ onClose }: Props) {
    const saveAIConfigs = useAppStore((state) => state.saveAIConfigs);
    const loadAIConfigs = useAppStore((state) => state.loadAIConfigs);

    const [configs, setConfigs] = useState<AIProviderConfig[]>([]);
    const [storedKeyStatus, setStoredKeyStatus] = useState<Record<string, boolean>>({});
    const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
    const [clearedKeyIds, setClearedKeyIds] = useState<string[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        let isMounted = true;

        loadAIConfigs()
            .then(({ aiConfigs, aiKeyStatus }) => {
                if (!isMounted) return;

                setConfigs(
                    normalizeProviderDrafts(aiConfigs)
                );
                setStoredKeyStatus(aiKeyStatus);
                setKeyDrafts({});
                setClearedKeyIds([]);
                setSaveError(null);
                setEditingId((currentId) => currentId && aiConfigs.some((config) => config.id === currentId)
                    ? currentId
                    : aiConfigs[0]?.id ?? null);
            })
            .catch((error) => {
                if (!isMounted) return;
                setSaveError(error instanceof Error ? error.message : String(error));
            });

        return () => {
            isMounted = false;
        };
    }, [loadAIConfigs]);

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
            allow_schema_context: false,
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
    const enabledCount = configs.filter((config) => config.is_enabled).length;
    const inUseCount = configs.filter((config) => config.is_enabled && config.is_primary).length;
    const hasStoredKey = activeConfig ? storedKeyStatus[activeConfig.id] && !clearedKeyIds.includes(activeConfig.id) : false;
    const canEditEndpoint = activeConfig?.provider_type === "custom" || activeConfig?.provider_type === "ollama";
    const defaultEndpoint = activeConfig ? DEFAULT_PROVIDER_ENDPOINTS[activeConfig.provider_type] ?? "" : "";
    const effectiveEndpoint = activeConfig ? (activeConfig.endpoint.trim() || defaultEndpoint) : "";
    const activeProviderOption = activeConfig
        ? PROVIDER_OPTIONS.find((option) => option.value === activeConfig.provider_type)
        : null;
    const isActiveProviderInUse = !!activeConfig?.is_enabled && !!activeConfig?.is_primary;

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

    return (
        <div className="ai-settings-overlay">
            <div className="ai-settings-modal">
                <header className="ai-settings-shell-header">
                    <div className="ai-settings-shell-copy">
                        <span className="panel-kicker">AI Workspace</span>
                        <h2 className="ai-settings-shell-title">Provider Settings</h2>
                        <p className="ai-settings-shell-subtitle">
                            Manage model providers, credentials, and which assistant is active inside the editor.
                        </p>
                    </div>
                    <div className="ai-settings-shell-actions">
                        <button onClick={onClose} className="btn btn-secondary">
                            Cancel
                        </button>
                        <button onClick={handleSave} className="btn btn-primary" disabled={isSaving}>
                            {isSaving ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Saving...
                                </>
                            ) : (
                                "Save All"
                            )}
                        </button>
                    </div>
                </header>

                {saveError && (
                    <div className="px-6 pt-4 text-sm text-[var(--error)]">
                        {saveError}
                    </div>
                )}

                <div className="ai-settings-shell-body">
                    <aside className="ai-settings-sidebar">
                        <div className="ai-settings-sidebar-head">
                            <div>
                                <h3 className="ai-settings-sidebar-title">AI Providers</h3>
                                <div className="ai-settings-sidebar-stats">
                                    <span className="ai-settings-stat">{configs.length} configured</span>
                                    <span className="ai-settings-stat">{enabledCount} enabled</span>
                                    <span className="ai-settings-stat">{inUseCount} in use</span>
                                </div>
                            </div>
                            <button onClick={handleAdd} className="ai-settings-add-btn" title="Add provider">
                                <Plus className="w-4 h-4" />
                                <span>Add</span>
                            </button>
                        </div>

                        {configs.length === 0 ? (
                            <div className="ai-settings-empty-list">
                                <Brain className="w-9 h-9" />
                                <div>
                                    <h4>No providers yet</h4>
                                    <p>Add your first model provider to enable AI chat and inline completion.</p>
                                </div>
                                <button onClick={handleAdd} className="btn btn-primary">
                                    <Plus className="w-4 h-4" />
                                    Create Provider
                                </button>
                            </div>
                        ) : (
                            <div className="ai-provider-list">
                                {configs.map((config) => (
                                    <button
                                        key={config.id}
                                        onClick={() => setEditingId(config.id)}
                                        className={`ai-provider-card ${editingId === config.id ? "active" : ""}`}
                                    >
                                        <div className="ai-provider-card-head">
                                            <div className="ai-provider-card-icon">
                                                <Cpu className="w-4 h-4" />
                                            </div>
                                            <div className="ai-provider-card-copy">
                                                <span className="ai-provider-card-type">
                                                    {PROVIDER_NAMES[config.provider_type]}
                                                </span>
                                                <strong className="ai-provider-card-name">
                                                    {config.name || PROVIDER_NAMES[config.provider_type] || "Unnamed"}
                                                </strong>
                                                <span className="ai-provider-card-model">
                                                    {config.model || "No model selected"}
                                                </span>
                                            </div>
                                        </div>
                                        <div className="ai-provider-card-badges">
                                            {config.is_enabled && config.is_primary && (
                                                <span className="ai-provider-card-badge is-primary">In use</span>
                                            )}
                                            <span className={`ai-provider-card-badge ${config.is_enabled ? "is-enabled" : "is-disabled"}`}>
                                                {config.is_enabled ? "Enabled" : "Disabled"}
                                            </span>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </aside>

                    <section className="ai-settings-detail">
                        {activeConfig ? (
                            <>
                                <div className="ai-settings-toolbar">
                                    <div className="ai-settings-toolbar-main">
                                        <div className="ai-settings-toolbar-icon">
                                            <Sparkles className="w-5 h-5" />
                                        </div>
                                        <div className="ai-settings-toolbar-copy">
                                            <span className="ai-settings-toolbar-kicker">Workspace AI</span>
                                            <h3>{activeConfig.name || PROVIDER_NAMES[activeConfig.provider_type]}</h3>
                                            <p>{PROVIDER_HINTS[activeConfig.provider_type]}</p>
                                            <div className="ai-settings-toolbar-meta">
                                                <span className="ai-settings-toolbar-chip">{PROVIDER_NAMES[activeConfig.provider_type]}</span>
                                                <span className="ai-settings-toolbar-chip">{activeConfig.model || "No model"}</span>
                                                <span className="ai-settings-toolbar-chip">
                                                    {activeConfig.allow_schema_context ? "Schema sharing on" : "Prompt only"}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="ai-settings-toolbar-actions">
                                        <span className={`ai-settings-active-badge ${isActiveProviderInUse ? "is-primary" : activeConfig.is_enabled ? "is-enabled" : "is-disabled"}`}>
                                            {isActiveProviderInUse ? "Using for AI" : activeConfig.is_enabled ? "Enabled only" : "Disabled"}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => setPrimaryProvider(activeConfig.id)}
                                            className={`ai-settings-inline-btn ${isActiveProviderInUse ? "is-active" : ""}`}
                                            disabled={isActiveProviderInUse}
                                        >
                                            {isActiveProviderInUse ? "Active provider" : "Use for AI"}
                                        </button>
                                        <button
                                            onClick={() => handleDelete(activeConfig.id)}
                                            className="ai-provider-delete-btn"
                                            title="Delete Provider"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>

                                <div className="ai-settings-panels">
                                    <section className="ai-settings-panel">
                                        <div className="ai-settings-panel-head">
                                            <Edit2 className="w-4 h-4" />
                                            <div>
                                                <h4>Identity</h4>
                                                <p>Name the provider and choose the engine this workspace should talk to.</p>
                                            </div>
                                        </div>
                                        <div className="ai-settings-fields">
                                            <div>
                                                <label className="form-label">Name</label>
                                                <input
                                                    type="text"
                                                    value={activeConfig.name}
                                                    onChange={(e) => updateConfig(activeConfig.id, { name: e.target.value })}
                                                    className="input"
                                                />
                                            </div>
                                            <div className="ai-settings-provider-picker">
                                                <label className="form-label">Provider Type</label>
                                                <div className="ai-settings-provider-tabs" role="listbox" aria-label="Provider Type">
                                                    {PROVIDER_OPTIONS.map((option) => {
                                                        const selected = option.value === activeConfig.provider_type;
                                                        return (
                                                            <button
                                                                key={option.value}
                                                                type="button"
                                                                role="option"
                                                                aria-selected={selected}
                                                                className={`ai-settings-provider-tab ${selected ? "is-selected" : ""}`}
                                                                onClick={() => updateConfig(activeConfig.id, { provider_type: option.value })}
                                                            >
                                                                <span>{option.label}</span>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                                {activeProviderOption && (
                                                    <p className="ai-settings-note ai-settings-note-subtle">
                                                        {activeProviderOption.meta}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                    </section>

                                    <section className="ai-settings-panel">
                                        <div className="ai-settings-panel-head">
                                            <Link2 className="w-4 h-4" />
                                            <div>
                                                <h4>Connection</h4>
                                                <p>Configure the model, credentials, and endpoint this provider should use.</p>
                                            </div>
                                        </div>
                                        <div className="ai-settings-fields">
                                            <div>
                                                <label className="form-label">Model Name</label>
                                                <input
                                                    type="text"
                                                    value={activeConfig.model}
                                                    onChange={(e) => updateConfig(activeConfig.id, { model: e.target.value })}
                                                    placeholder="e.g. gpt-4o-mini"
                                                    className="input"
                                                />
                                            </div>
                                            <div>
                                                <label className="form-label">
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
                                                            ? "Stored securely - enter a new key to replace it"
                                                            : activeConfig.provider_type === "ollama"
                                                                ? "Leave blank for local Ollama without auth"
                                                                : activeConfig.provider_type === "custom"
                                                                    ? "Optional for unsecured OpenAI-compatible endpoints"
                                                                    : "sk-..."
                                                    }
                                                    className="input ai-settings-mono"
                                                />
                                            </div>
                                            <div className="ai-settings-credential-row">
                                                <span className={`ai-provider-card-status ${hasStoredKey ? "enabled" : ""}`}>
                                                    {hasStoredKey ? "Key stored securely" : "No key stored yet"}
                                                </span>
                                                {hasStoredKey && (
                                                    <button
                                                        type="button"
                                                        onClick={() => handleClearStoredKey(activeConfig.id)}
                                                        className="btn btn-secondary"
                                                    >
                                                        Clear Stored Key
                                                    </button>
                                                )}
                                            </div>
                                            {canEditEndpoint ? (
                                                <>
                                                <div>
                                                    <label className="form-label">
                                                        {activeConfig.provider_type === "ollama" ? "Ollama Endpoint URL" : "Custom Endpoint URL"}
                                                    </label>
                                                    <input
                                                        type="text"
                                                        value={activeConfig.endpoint}
                                                        onChange={(e) => updateConfig(activeConfig.id, { endpoint: e.target.value })}
                                                        placeholder={
                                                            activeConfig.provider_type === "ollama"
                                                                ? "http://localhost:11434/v1/chat/completions"
                                                                : "https://api.yourdomain.com/v1/chat/completions"
                                                        }
                                                        className="input ai-settings-mono"
                                                    />
                                                </div>
                                                <p className="ai-settings-helper">
                                                    {activeConfig.provider_type === "ollama"
                                                        ? `Leave it blank to use the default local Ollama endpoint: ${defaultEndpoint}`
                                                        : "Use a full OpenAI-compatible chat completions URL."}
                                                </p>
                                                <div className="ai-settings-note">
                                                    Effective endpoint: {effectiveEndpoint || "Not set"}
                                                </div>
                                                </>
                                            ) : (
                                                <>
                                                    <p className="ai-settings-helper">
                                                        This hosted provider uses its default endpoint automatically.
                                                    </p>
                                                    <div className="ai-settings-note">
                                                        {defaultEndpoint
                                                            ? `Default endpoint: ${defaultEndpoint}`
                                                            : `No custom endpoint is needed for ${PROVIDER_NAMES[activeConfig.provider_type]}.`}
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </section>

                                    <section className="ai-settings-panel ai-settings-panel-wide">
                                        <div className="ai-settings-panel-head">
                                            <KeyRound className="w-4 h-4" />
                                            <div>
                                                <h4>Workspace Access</h4>
                                                <p>Choose what this provider can see, and which one the workspace should actively use.</p>
                                            </div>
                                        </div>
                                        <div className="ai-settings-capability-list">
                                            <div className="ai-settings-capability-row">
                                                <div className="ai-settings-capability-copy">
                                                    <span className="form-label">Routing</span>
                                                    <h4>Use this provider for AI</h4>
                                                    <p>Only one enabled provider can be the active chat and agent provider at a time.</p>
                                                </div>
                                                <div className="ai-settings-toggle-side">
                                                    <span className={`ai-settings-toggle-badge ${isActiveProviderInUse ? "is-on" : ""}`}>
                                                        {isActiveProviderInUse ? "In use" : "Standby"}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        onClick={() => setPrimaryProvider(activeConfig.id)}
                                                        className={`ai-settings-inline-btn ${isActiveProviderInUse ? "is-active" : ""}`}
                                                        disabled={isActiveProviderInUse}
                                                    >
                                                        {isActiveProviderInUse ? "Active provider" : "Use for AI"}
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="ai-settings-capability-row">
                                                <div className="ai-settings-capability-copy">
                                                    <span className="form-label">Availability</span>
                                                    <h4>Enable this provider</h4>
                                                    <p>Only enabled providers can be used by AI chat and auto-completion.</p>
                                                </div>
                                                <div className="ai-settings-toggle-side">
                                                    <span className={`ai-settings-toggle-badge ${activeConfig.is_enabled ? "is-on" : ""}`}>
                                                        {activeConfig.is_enabled ? "Enabled" : "Disabled"}
                                                    </span>
                                                    <label className="ai-settings-toggle-control">
                                                        <input
                                                            type="checkbox"
                                                            checked={activeConfig.is_enabled}
                                                            onChange={(e) => updateConfig(activeConfig.id, {
                                                                is_enabled: e.target.checked,
                                                                is_primary: e.target.checked ? activeConfig.is_primary : false,
                                                            })}
                                                        />
                                                        <span>{activeConfig.is_enabled ? "On" : "Off"}</span>
                                                    </label>
                                                </div>
                                            </div>
                                            <div className="ai-settings-capability-row">
                                                <div className="ai-settings-capability-copy">
                                                    <span className="form-label">Privacy</span>
                                                    <h4>Allow schema context sharing</h4>
                                                    <p>
                                                        When enabled, AI requests may include database and table context to improve accuracy.
                                                    </p>
                                                </div>
                                                <div className="ai-settings-toggle-side">
                                                    <span className={`ai-settings-toggle-badge ${activeConfig.allow_schema_context ? "is-on" : ""}`}>
                                                        {activeConfig.allow_schema_context ? "Allowed" : "Blocked"}
                                                    </span>
                                                    <label className="ai-settings-toggle-control">
                                                        <input
                                                            type="checkbox"
                                                            checked={activeConfig.allow_schema_context}
                                                            onChange={(e) => updateConfig(activeConfig.id, { allow_schema_context: e.target.checked })}
                                                        />
                                                        <span>{activeConfig.allow_schema_context ? "On" : "Off"}</span>
                                                    </label>
                                                </div>
                                            </div>
                                            <div className="ai-settings-capability-row">
                                                <div className="ai-settings-capability-copy">
                                                    <span className="form-label">Editor Assist</span>
                                                    <h4>Allow inline completion</h4>
                                                    <p>
                                                        Inline completion sends your partial SQL while you type. Keep this off unless you trust the provider. TabLer only runs it automatically on local or file-based connections by default.
                                                    </p>
                                                </div>
                                                <div className="ai-settings-toggle-side">
                                                    <span className={`ai-settings-toggle-badge ${activeConfig.allow_inline_completion ? "is-on" : ""}`}>
                                                        {activeConfig.allow_inline_completion ? "Allowed" : "Blocked"}
                                                    </span>
                                                    <label className="ai-settings-toggle-control">
                                                        <input
                                                            type="checkbox"
                                                            checked={activeConfig.allow_inline_completion}
                                                            onChange={(e) => updateConfig(activeConfig.id, { allow_inline_completion: e.target.checked })}
                                                        />
                                                        <span>{activeConfig.allow_inline_completion ? "On" : "Off"}</span>
                                                    </label>
                                                </div>
                                            </div>
                                        </div>
                                    </section>
                                </div>
                            </>
                        ) : (
                            <div className="ai-settings-empty-state">
                                <div className="ai-settings-empty-card">
                                    <Brain className="w-12 h-12" />
                                    <h3>Select a provider</h3>
                                    <p>Pick one from the left to edit it, or create a new provider to start using AI.</p>
                                    <button onClick={handleAdd} className="btn btn-primary">
                                        <Plus className="w-4 h-4" />
                                        Add Provider
                                    </button>
                                </div>
                            </div>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}
