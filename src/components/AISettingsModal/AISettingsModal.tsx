import { useState, useEffect } from "react";
import { Plus, Trash2, Cpu, Brain, Edit2, KeyRound, Sparkles, Link2 } from "lucide-react";
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

export function AISettingsModal({ onClose }: Props) {
    const { saveAIConfigs, loadAIConfigs } = useAppStore();

    const [configs, setConfigs] = useState<AIProviderConfig[]>([]);
    const [keys, setKeys] = useState<Record<string, string>>({});
    const [editingId, setEditingId] = useState<string | null>(null);

    useEffect(() => {
        let isMounted = true;

        loadAIConfigs().then(() => {
            if (!isMounted) return;

            const { aiConfigs, apiKeys } = useAppStore.getState();
            setConfigs(aiConfigs);
            setKeys(apiKeys);
            setEditingId((currentId) => currentId && aiConfigs.some((config) => config.id === currentId)
                ? currentId
                : aiConfigs[0]?.id ?? null);
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
        const newId = crypto.randomUUID();
        setConfigs([...configs, {
            id: newId,
            name: "New Provider",
            provider_type: "openai",
            endpoint: "",
            model: "gpt-4o-mini",
            is_enabled: true,
        }]);
        setEditingId(newId);
    };

    const handleDelete = (id: string) => {
        const remainingConfigs = configs.filter((c) => c.id !== id);
        setConfigs(remainingConfigs);
        const newKeys = { ...keys };
        delete newKeys[id];
        setKeys(newKeys);
        if (editingId === id) {
            setEditingId(remainingConfigs[0]?.id ?? null);
        }
    };

    const handleSave = async () => {
        await saveAIConfigs(configs, keys);
        onClose();
    };

    const updateConfig = (id: string, updates: Partial<AIProviderConfig>) => {
        setConfigs(configs.map(c => c.id === id ? { ...c, ...updates } : c));
    };

    const activeConfig = configs.find(c => c.id === editingId);
    const enabledCount = configs.filter((config) => config.is_enabled).length;

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
                        <button onClick={handleSave} className="btn btn-primary">
                            Save All
                        </button>
                    </div>
                </header>

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
                                                <label className="form-label">API Key</label>
                                                <input
                                                    type="password"
                                                    value={keys[activeConfig.id] || ""}
                                                    onChange={(e) => setKeys({ ...keys, [activeConfig.id]: e.target.value })}
                                                    placeholder="sk-..."
                                                    className="input ai-settings-mono"
                                                />
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
                                                        : "Hosted providers use their default endpoint automatically."}
                                                </p>
                                            </div>
                                        </div>
                                        {activeConfig.provider_type === "custom" ? (
                                            <div className="ai-settings-fields">
                                                <div>
                                                    <label className="form-label">Custom Endpoint URL</label>
                                                    <input
                                                        type="text"
                                                        value={activeConfig.endpoint}
                                                        onChange={(e) => updateConfig(activeConfig.id, { endpoint: e.target.value })}
                                                        placeholder="https://api.yourdomain.com/v1/chat/completions"
                                                        className="input ai-settings-mono"
                                                    />
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="ai-settings-note">
                                                No custom endpoint is needed for {PROVIDER_NAMES[activeConfig.provider_type]}.
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
