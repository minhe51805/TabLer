import { useState, useEffect } from "react";
import { Plus, Trash2, Cpu, Brain, Edit2 } from "lucide-react";
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

export function AISettingsModal({ onClose }: Props) {
    const { saveAIConfigs, loadAIConfigs } = useAppStore();

    const [configs, setConfigs] = useState<AIProviderConfig[]>([]);
    const [keys, setKeys] = useState<Record<string, string>>({});
    const [editingId, setEditingId] = useState<string | null>(null);

    useEffect(() => {
        loadAIConfigs().then(() => {
            setConfigs(useAppStore.getState().aiConfigs);
            setKeys(useAppStore.getState().apiKeys);
        });
    }, []);

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
        setConfigs(configs.filter((c) => c.id !== id));
        const newKeys = { ...keys };
        delete newKeys[id];
        setKeys(newKeys);
        if (editingId === id) setEditingId(null);
    };

    const handleSave = async () => {
        await saveAIConfigs(configs, keys);
        onClose();
    };

    const updateConfig = (id: string, updates: Partial<AIProviderConfig>) => {
        setConfigs(configs.map(c => c.id === id ? { ...c, ...updates } : c));
    };

    const activeConfig = configs.find(c => c.id === editingId);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-8 py-8 bg-[rgba(2,8,23,0.72)] backdrop-blur-md">
            <div className="w-full max-w-[800px] h-[600px] bg-[var(--bg-secondary)] border border-white/15 rounded-md overflow-hidden flex shadow-[0_30px_80px_rgba(0,0,0,0.55)]">

                {/* Sidebar: List of configs */}
                <div className="w-64 border-r border-white/10 flex flex-col bg-[rgba(0,0,0,0.2)]">
                    <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                        <h3 className="font-semibold text-sm">AI Providers</h3>
                        <button onClick={handleAdd} className="hover:bg-white/10 p-1 rounded-sm transition-colors">
                            <Plus className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-1">
                        {configs.length === 0 ? (
                            <p className="text-[12px] text-[var(--text-muted)] text-center mt-10">No providers configured</p>
                        ) : (
                            configs.map(c => (
                                <button
                                    key={c.id}
                                    onClick={() => setEditingId(c.id)}
                                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-left text-[13px] transition-colors ${editingId === c.id ? "bg-[var(--accent)]/20 text-[var(--accent)]" : "hover:bg-white/5 text-[var(--text-secondary)]"
                                        }`}
                                >
                                    <Cpu className="w-4 h-4 shrink-0" />
                                    <span className="truncate flex-1">{c.name || PROVIDER_NAMES[c.provider_type] || "Unnamed"}</span>
                                    {!c.is_enabled && <span className="text-[10px] bg-white/10 px-1 rounded-sm shrink-0">Off</span>}
                                </button>
                            ))
                        )}
                    </div>
                    <div className="p-3 border-t border-white/5">
                        <button onClick={handleSave} className="btn w-full justify-center bg-[var(--accent)] text-[#0f172a] font-semibold hover:opacity-90">
                            Save All
                        </button>
                        <button onClick={onClose} className="btn w-full justify-center mt-2 bg-white/5 hover:bg-white/10">
                            Cancel
                        </button>
                    </div>
                </div>

                {/* Main: Edit form */}
                <div className="flex-1 flex flex-col min-w-0 bg-[var(--bg-surface)]">
                    {activeConfig ? (
                        <div className="flex-1 overflow-y-auto p-6 space-y-5">
                            <div className="flex items-center justify-between">
                                <h2 className="text-lg font-semibold flex items-center gap-2">
                                    <Edit2 className="w-4 h-4" /> Edit Provider
                                </h2>
                                <button onClick={() => handleDelete(activeConfig.id)} className="text-red-400 hover:text-red-300 hover:bg-red-400/10 p-1.5 rounded-md transition-colors" title="Delete Provider">
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="form-label uppercase tracking-wide">Name</label>
                                    <input
                                        type="text"
                                        value={activeConfig.name}
                                        onChange={(e) => updateConfig(activeConfig.id, { name: e.target.value })}
                                        className="input h-9"
                                    />
                                </div>
                                <div>
                                    <label className="form-label uppercase tracking-wide">Provider Type</label>
                                    <select
                                        value={activeConfig.provider_type}
                                        onChange={(e) => updateConfig(activeConfig.id, { provider_type: e.target.value as AIProviderType })}
                                        className="input h-9 appearance-none"
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

                            <div>
                                <label className="form-label uppercase tracking-wide">Model Name</label>
                                <input
                                    type="text"
                                    value={activeConfig.model}
                                    onChange={(e) => updateConfig(activeConfig.id, { model: e.target.value })}
                                    placeholder="e.g. gpt-4o"
                                    className="input h-9"
                                />
                            </div>

                            <div>
                                <label className="form-label uppercase tracking-wide">API Key</label>
                                <input
                                    type="password"
                                    value={keys[activeConfig.id] || ""}
                                    onChange={(e) => setKeys({ ...keys, [activeConfig.id]: e.target.value })}
                                    placeholder="sk-..."
                                    className="input h-9 font-mono text-[12px]"
                                />
                                <p className="text-[10px] text-[var(--text-muted)] mt-1.5">Stored securely in OS Keychain.</p>
                            </div>

                            {activeConfig.provider_type === "custom" && (
                                <div>
                                    <label className="form-label uppercase tracking-wide">Custom Endpoint URL</label>
                                    <input
                                        type="text"
                                        value={activeConfig.endpoint}
                                        onChange={(e) => updateConfig(activeConfig.id, { endpoint: e.target.value })}
                                        placeholder="https://api.yourdomain.com/v1/chat/completions"
                                        className="input h-9 font-mono text-[12px]"
                                    />
                                </div>
                            )}

                            <div className="pt-2">
                                <label className="flex items-center gap-2 cursor-pointer w-max">
                                    <input
                                        type="checkbox"
                                        checked={activeConfig.is_enabled}
                                        onChange={(e) => updateConfig(activeConfig.id, { is_enabled: e.target.checked })}
                                        className="rounded border-white/20 bg-black/20 text-[var(--accent)] focus:ring-[var(--accent)]/50 focus:ring-offset-0"
                                    />
                                    <span className="text-sm">Enable this provider</span>
                                </label>
                            </div>

                        </div>
                    ) : (
                        <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)]">
                            <Brain className="w-12 h-12 mb-3 opacity-20" />
                            <p>Select a provider to edit or add a new one.</p>
                        </div>
                    )}
                </div>

            </div>
        </div>
    );
}
