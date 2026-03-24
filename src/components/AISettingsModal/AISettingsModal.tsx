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
                    aiConfigs.map((config) => ({
                        ...config,
                        allow_schema_context: config.allow_schema_context ?? false,
                        allow_inline_completion: config.allow_inline_completion ?? false,
                    }))
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
        setConfigs([...configs, {
            id: newId,
            name: "New Provider",
            provider_type: "openai",
            endpoint: "",
            model: "gpt-4o-mini",
            is_enabled: true,
            allow_schema_context: false,
            allow_inline_completion: false,
        }]);
        setEditingId(newId);
    };

    const handleDelete = (id: string) => {
        setSaveError(null);
        const remainingConfigs = configs.filter((c) => c.id !== id);
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
            setConfigs(
                aiConfigs.map((config) => ({
                    ...config,
                    allow_schema_context: config.allow_schema_context ?? false,
                    allow_inline_completion: config.allow_inline_completion ?? false,
                }))
            );
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
        setConfigs(configs.map(c => c.id === id ? { ...c, ...updates } : c));
    };

    const activeConfig = configs.find(c => c.id === editingId);
    const enabledCount = configs.filter((config) => config.is_enabled).length;
    const hasStoredKey = activeConfig ? storedKeyStatus[activeConfig.id] && !clearedKeyIds.includes(activeConfig.id) : false;
    const canEditEndpoint = activeConfig?.provider_type === "custom" || activeConfig?.provider_type === "ollama";
    const defaultEndpoint = activeConfig ? DEFAULT_PROVIDER_ENDPOINTS[activeConfig.provider_type] ?? "" : "";
    const effectiveEndpoint = activeConfig ? (activeConfig.endpoint.trim() || defaultEndpoint) : "";

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
                                                <span className="ai-provider-card-model">{config.model || "No model selected"}</span>
                                            </div>
                                        </div>
                                        <div className="ai-provider-card-footer">
                                            <span className={`ai-provider-card-status ${config.is_enabled ? "enabled" : ""}`}>
                                                {config.is_enabled ? "Enabled" : "Disabled"}
                                            </span>
                                            <span className="ai-provider-card-link">
                                                Edit
                                                <Edit2 className="w-3.5 h-3.5" />
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
                                <div className="ai-provider-hero">
                                    <div className="ai-provider-hero-icon">
                                        <Sparkles className="w-6 h-6" />
                                    </div>
                                    <div className="ai-provider-hero-copy">
                                        <span className="ai-provider-hero-kicker">{PROVIDER_NAMES[activeConfig.provider_type]}</span>
                                        <h3>{activeConfig.name || PROVIDER_NAMES[activeConfig.provider_type]}</h3>
                                        <p>{PROVIDER_HINTS[activeConfig.provider_type]}</p>
                                    </div>
                                    <div className="ai-provider-hero-meta">
                                        <span className={`ai-provider-hero-status ${activeConfig.is_enabled ? "enabled" : ""}`}>
                                            {activeConfig.is_enabled ? "Ready" : "Disabled"}
                                        </span>
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
                                                <p>Name the provider and choose its backend type.</p>
                                            </div>
                                        </div>
                                        <div className="ai-settings-fields ai-settings-fields-two-col">
                                            <div>
                                                <label className="form-label">Name</label>
                                                <input
                                                    type="text"
                                                    value={activeConfig.name}
                                                    onChange={(e) => updateConfig(activeConfig.id, { name: e.target.value })}
                                                    className="input"
                                                />
                                            </div>
                                            <div>
                                                <label className="form-label">Provider Type</label>
                                                <select
                                                    value={activeConfig.provider_type}
                                                    onChange={(e) => updateConfig(activeConfig.id, { provider_type: e.target.value as AIProviderType })}
                                                    className="input ai-settings-select"
                                                >
                                                    <option value="openai">OpenAI</option>
                                                    <option value="anthropic">Claude</option>
                                                    <option value="openrouter">OpenRouter</option>
                                                    <option value="ollama">Ollama</option>
                                                    <option value="gemini">Gemini</option>
                                                    <option value="custom">Custom</option>
                                                </select>
                                            </div>
                                        </div>
                                    </section>

                                    <section className="ai-settings-panel">
                                        <div className="ai-settings-panel-head">
                                            <Cpu className="w-4 h-4" />
                                            <div>
                                                <h4>Model Routing</h4>
                                                <p>Choose which model this provider should call.</p>
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
                                            <p className="ai-settings-helper">
                                                This model will be used for AI chat requests and editor assistance.
                                            </p>
                                        </div>
                                    </section>

                                    <section className="ai-settings-panel ai-settings-panel-wide">
                                        <div className="ai-settings-panel-head">
                                            <KeyRound className="w-4 h-4" />
                                            <div>
                                                <h4>Credentials</h4>
                                                <p>API keys are stored securely in the operating system keychain.</p>
                                            </div>
                                        </div>
                                        <div className="ai-settings-fields">
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
                                        </div>
                                    </section>

                                    <section className="ai-settings-panel ai-settings-panel-wide">
                                        <div className="ai-settings-panel-head">
                                            <Link2 className="w-4 h-4" />
                                            <div>
                                                <h4>Endpoint</h4>
                                                <p>
                                                    {activeConfig.provider_type === "custom"
                                                        ? "Point this provider at your own OpenAI-compatible endpoint."
                                                        : activeConfig.provider_type === "ollama"
                                                            ? "Choose where TableR should reach your Ollama server."
                                                            : "Hosted providers use their default endpoint automatically."}
                                                </p>
                                            </div>
                                        </div>
                                        {canEditEndpoint ? (
                                            <div className="ai-settings-fields">
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
                                            </div>
                                        ) : (
                                            <div className="ai-settings-note">
                                                {defaultEndpoint
                                                    ? `TableR will use the default ${PROVIDER_NAMES[activeConfig.provider_type]} endpoint: ${defaultEndpoint}`
                                                    : `No custom endpoint is needed for ${PROVIDER_NAMES[activeConfig.provider_type]}.`}
                                            </div>
                                        )}
                                    </section>

                                    <section className="ai-settings-panel ai-settings-panel-wide">
                                        <div className="ai-settings-toggle">
                                            <div className="ai-settings-toggle-copy">
                                                <span className="form-label">Availability</span>
                                                <h4>Enable this provider</h4>
                                                <p>Only enabled providers can be used by AI chat and auto-completion.</p>
                                            </div>
                                            <label className="ai-settings-toggle-control">
                                                <input
                                                    type="checkbox"
                                                    checked={activeConfig.is_enabled}
                                                    onChange={(e) => updateConfig(activeConfig.id, { is_enabled: e.target.checked })}
                                                />
                                                <span>{activeConfig.is_enabled ? "Enabled" : "Disabled"}</span>
                                            </label>
                                        </div>
                                    </section>

                                    <section className="ai-settings-panel ai-settings-panel-wide">
                                        <div className="ai-settings-toggle">
                                            <div className="ai-settings-toggle-copy">
                                                <span className="form-label">Privacy</span>
                                                <h4>Allow schema context sharing</h4>
                                                <p>
                                                    When enabled, AI requests may include database and table context to improve accuracy.
                                                </p>
                                            </div>
                                            <label className="ai-settings-toggle-control">
                                                <input
                                                    type="checkbox"
                                                    checked={activeConfig.allow_schema_context}
                                                    onChange={(e) => updateConfig(activeConfig.id, { allow_schema_context: e.target.checked })}
                                                />
                                                <span>{activeConfig.allow_schema_context ? "Allowed" : "Blocked"}</span>
                                            </label>
                                        </div>
                                    </section>

                                    <section className="ai-settings-panel ai-settings-panel-wide">
                                        <div className="ai-settings-toggle">
                                            <div className="ai-settings-toggle-copy">
                                                <span className="form-label">Editor Assist</span>
                                                <h4>Allow inline completion</h4>
                                                <p>
                                                    Inline completion sends your partial SQL while you type. Keep this off unless you trust the provider. TabLer only runs it automatically on local or file-based connections by default.
                                                </p>
                                            </div>
                                            <label className="ai-settings-toggle-control">
                                                <input
                                                    type="checkbox"
                                                    checked={activeConfig.allow_inline_completion}
                                                    onChange={(e) => updateConfig(activeConfig.id, { allow_inline_completion: e.target.checked })}
                                                />
                                                <span>{activeConfig.allow_inline_completion ? "Allowed" : "Blocked"}</span>
                                            </label>
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
