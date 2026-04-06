import { useState, useEffect } from "react";
import { Plus, Trash2, Brain, Sparkles, Loader2, Check } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import type { AIProviderConfig } from "../../types";

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
                        <button onClick={onClose} className="ai-settings-btn-cancel">
                            Cancel
                        </button>
                        <button onClick={handleSave} className="ai-settings-btn-save" disabled={isSaving}>
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
                            <button onClick={handleAdd} className="ai-settings-add-btn">
                                <Plus className="w-3.5 h-3.5" />
                                <span>Add</span>
                            </button>
                        </div>

                        {configs.length === 0 ? (
                            <div className="ai-settings-empty">
                                <Brain className="w-10 h-10" />
                                <h4>No providers yet</h4>
                                <p>Add your first model provider to enable AI chat.</p>
                                <button onClick={handleAdd} className="ai-settings-btn-primary">
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
                                        <div className="ai-provider-card-type">
                                            {PROVIDER_NAMES[config.provider_type]?.toUpperCase()}
                                        </div>
                                        <div className="ai-provider-card-name">
                                            {config.name || PROVIDER_NAMES[config.provider_type] || "Unnamed"}
                                        </div>
                                        <div className="ai-provider-card-model">
                                            {config.model || "No model selected"}
                                        </div>
                                        <div className="ai-provider-card-badges">
                                            {config.is_enabled && config.is_primary && (
                                                <span className="ai-provider-badge ai-provider-badge-inuse">IN USE</span>
                                            )}
                                            <span className={`ai-provider-badge ${config.is_enabled ? "ai-provider-badge-enabled" : "ai-provider-badge-disabled"}`}>
                                                {config.is_enabled ? "ENABLED" : "DISABLED"}
                                            </span>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </aside>

                    {/* Main Content */}
                    <section className="ai-settings-content">
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
                                            {PROVIDER_NAMES[activeConfig.provider_type]} {activeConfig.model && `• ${activeConfig.model}`}
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
                                    <span className="ai-settings-workspace-status">
                                        {isActiveProviderInUse ? "Using for AI" : activeConfig.is_enabled ? "ENABLED ONLY" : "DISABLED"}
                                    </span>
                                    {!isActiveProviderInUse && (
                                        <button
                                            type="button"
                                            onClick={() => setPrimaryProvider(activeConfig.id)}
                                            className="ai-settings-btn-use"
                                        >
                                            Use for AI
                                        </button>
                                    )}
                                    <button
                                        onClick={() => handleDelete(activeConfig.id)}
                                        className="ai-settings-btn-delete"
                                        title="Delete Provider"
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
                                            <label className="ai-settings-label">Name</label>
                                            <input
                                                type="text"
                                                value={activeConfig.name}
                                                onChange={(e) => updateConfig(activeConfig.id, { name: e.target.value })}
                                                className="ai-settings-input"
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
                                            />
                                            {hasStoredKey && (
                                                <button
                                                    type="button"
                                                    onClick={() => handleClearStoredKey(activeConfig.id)}
                                                    className="ai-settings-btn-clear"
                                                >
                                                    Clear Stored Key
                                                </button>
                                            )}
                                        </div>
                                        {(activeConfig.provider_type === "ollama" || activeConfig.provider_type === "custom") && (
                                            <div className="ai-settings-field">
                                                <label className="ai-settings-label">Endpoint URL</label>
                                                <input
                                                    type="text"
                                                    value={activeConfig.endpoint}
                                                    onChange={(e) => updateConfig(activeConfig.id, { endpoint: e.target.value })}
                                                    placeholder={activeConfig.provider_type === "ollama"
                                                        ? "http://localhost:11434/v1/chat/completions"
                                                        : "https://api.yourdomain.com/v1/chat/completions"}
                                                    className="ai-settings-input ai-settings-input-mono"
                                                />
                                            </div>
                                        )}
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
            </div>
        </div>
    );
}
