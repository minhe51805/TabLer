import {
  ArrowLeftRight,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  Database,
  Eye,
  Loader2,
  MessageSquare,
  PencilLine,
  Settings2,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  X,
  Zap,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState, type KeyboardEventHandler, type RefObject } from "react";
import type { AIProviderConfig } from "../../types";
import { formatAIProviderTypeLabel } from "../../utils/ai-provider-registry";
import { getAIFailoverConsent, setAIFailoverConsent } from "../../utils/ai-failover-consent";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";
import type {
  AIWorkspaceAgentAutonomy,
  AIWorkspaceInteractionMode,
} from "./ai-workspace-types";

interface AIComposerDockProps {
  copy: AIWorkspaceCopy;
  prompt: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  footerNote: string;
  attachedSelectionSource?: string;
  hasAttachedSelectionText: boolean;
  interactionMode: AIWorkspaceInteractionMode;
  agentAutonomy: AIWorkspaceAgentAutonomy;
  activeProvider: AIProviderConfig | undefined;
  providers: AIProviderConfig[];
  isSwitchingProvider: boolean;
  isGenerating: boolean;
  isCancelling: boolean;
  isConnectionAvailable: boolean;
  isSessionDataReadEnabled: boolean;
  sessionDataReadLabel: string;
  sessionDataReadTitle: string;
  showThinking: boolean;
  onPromptChange: (value: string) => void;
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onDismissSelection: () => void;
  onSelectInteractionMode: (mode: AIWorkspaceInteractionMode) => void;
  onSelectAgentAutonomy: (autonomy: AIWorkspaceAgentAutonomy) => void;
  onActivateProvider: (providerId: string, model?: string) => void;
  onToggleModelVisibility: (providerId: string, model: string) => void;
  onSetSessionDataReadEnabled: (enabled: boolean) => void;
  onSetShowThinking: (show: boolean) => void;
  onOpenSettings: () => void;
  onCloseHistory: () => void;
  onGenerate: () => void;
  onCancelGeneration: () => void;
}

type ComposerMenu = "mode" | "provider" | "utility";

const INTERACTION_MODES: AIWorkspaceInteractionMode[] = ["prompt", "edit", "agent"];
const AGENT_AUTONOMY_OPTIONS: AIWorkspaceAgentAutonomy[] = ["review", "smart", "full"];

function getInteractionModeLabel(mode: AIWorkspaceInteractionMode, copy: AIWorkspaceCopy) {
  if (mode === "agent") return copy.composer.modeAgent;
  if (mode === "edit") return copy.composer.modeEdit;
  return copy.composer.modePrompt;
}

function getInteractionModeHint(mode: AIWorkspaceInteractionMode, copy: AIWorkspaceCopy) {
  if (mode === "agent") return copy.composer.modeAgentHint;
  if (mode === "edit") return copy.composer.modeEditHint;
  return copy.composer.modePromptHint;
}

function renderInteractionModeIcon(mode: AIWorkspaceInteractionMode) {
  if (mode === "agent") return <Sparkles className="w-3.5 h-3.5" />;
  if (mode === "edit") return <PencilLine className="w-3.5 h-3.5" />;
  return <MessageSquare className="w-3.5 h-3.5" />;
}

function renderAgentAutonomyIcon(autonomy: AIWorkspaceAgentAutonomy) {
  if (autonomy === "full") return <Zap className="w-3.5 h-3.5" />;
  if (autonomy === "smart") return <ShieldCheck className="w-3.5 h-3.5" />;
  return <Shield className="w-3.5 h-3.5" />;
}

function getAgentAutonomyLabel(autonomy: AIWorkspaceAgentAutonomy, copy: AIWorkspaceCopy) {
  if (autonomy === "full") return copy.composer.agentAutonomyFull;
  if (autonomy === "smart") return copy.composer.agentAutonomySmart;
  return copy.composer.agentAutonomyReview;
}

function getAgentAutonomyHint(autonomy: AIWorkspaceAgentAutonomy, copy: AIWorkspaceCopy) {
  if (autonomy === "full") return copy.composer.agentAutonomyFullHint;
  if (autonomy === "smart") return copy.composer.agentAutonomySmartHint;
  return copy.composer.agentAutonomyReviewHint;
}

export function AIComposerDock({
  copy,
  prompt,
  textareaRef,
  footerNote,
  attachedSelectionSource,
  hasAttachedSelectionText,
  interactionMode,
  agentAutonomy,
  activeProvider,
  providers,
  isSwitchingProvider,
  isGenerating,
  isCancelling,
  isConnectionAvailable,
  isSessionDataReadEnabled,
  sessionDataReadLabel,
  sessionDataReadTitle,
  showThinking,
  onPromptChange,
  onKeyDown,
  onDismissSelection,
  onSelectInteractionMode,
  onSelectAgentAutonomy,
  onActivateProvider,
  onToggleModelVisibility,
  onSetSessionDataReadEnabled,
  onSetShowThinking,
  onOpenSettings,
  onCloseHistory,
  onGenerate,
  onCancelGeneration,
}: AIComposerDockProps) {
  const [openMenu, setOpenMenu] = useState<ComposerMenu | null>(null);
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [showHiddenModels, setShowHiddenModels] = useState(false);
  const commandBarRef = useRef<HTMLDivElement>(null);
  const activeProviderValue = activeProvider?.model?.trim()
    || activeProvider?.name?.trim()
    || copy.composer.noProvider;
  const activeProviderCaption = activeProvider
    ? activeProvider.name?.trim() && activeProvider.name.trim() !== activeProviderValue
      ? `${activeProvider.name.trim()} / ${formatAIProviderTypeLabel(activeProvider.provider_type)}`
      : formatAIProviderTypeLabel(activeProvider.provider_type)
    : copy.composer.openSettings;

  useEffect(() => {
    if (!openMenu) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (commandBarRef.current?.contains(event.target as Node | null)) return;
      setOpenMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };

    window.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("touchstart", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("touchstart", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [openMenu]);

  const toggleMenu = (menu: ComposerMenu) => {
    onCloseHistory();
    setOpenMenu((current) => current === menu ? null : menu);
  };

  // The model submenu defaults to the active provider and collapses with the menu.
  useEffect(() => {
    if (openMenu !== "provider") {
      setExpandedProviderId(null);
      setShowHiddenModels(false);
      return;
    }
    setExpandedProviderId((current) => current ?? activeProvider?.id ?? null);
  }, [openMenu, activeProvider?.id]);

  const hiddenModelEntries = providers.flatMap((config) => (
    (config.disabled_models ?? [])
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((model) => ({ config, model }))
  ));

  // Mirrors the failover consent (localStorage) and stays in sync when the
  // agent-side consent dialog records a decision.
  const [autoSwitchEnabled, setAutoSwitchEnabled] = useState(
    () => getAIFailoverConsent() === "approved",
  );
  useEffect(() => {
    const sync = () => setAutoSwitchEnabled(getAIFailoverConsent() === "approved");
    window.addEventListener("ai-failover-consent-change", sync);
    return () => window.removeEventListener("ai-failover-consent-change", sync);
  }, []);

  return (
    <div className="ai-workspace-compose-dock">
      {attachedSelectionSource && (
        <div className="ai-workspace-selection-chip">
          <div className="ai-workspace-selection-chip-copy">
            <span className="ai-workspace-selection-chip-kicker">{copy.composer.selectionReady}</span>
            <strong className="ai-workspace-selection-chip-title">{attachedSelectionSource}</strong>
          </div>
          <button type="button" className="ai-workspace-selection-chip-dismiss" onClick={onDismissSelection}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="ai-workspace-compose-box">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="ai-workspace-composer-textarea"
          placeholder={copy.composer.placeholder}
        />

        <div className={`ai-workspace-composer-footer ${footerNote ? "" : "is-note-hidden"}`}>
          <div className="ai-workspace-composer-footer-main">
            {footerNote ? (
              <div className="ai-workspace-composer-note">{footerNote}</div>
            ) : (
              <div className="ai-workspace-composer-note-spacer" aria-hidden="true" />
            )}

            <div
              ref={commandBarRef}
              className={`ai-workspace-commandbar ai-workspace-commandbar--dock ${interactionMode === "agent" ? "is-agent" : ""}`}
            >
              <div className={`ai-workspace-command-dropdown ${openMenu === "mode" ? "is-open" : ""}`}>
                <button
                  type="button"
                  className={`ai-workspace-command-trigger ${openMenu === "mode" ? "is-active" : ""}`}
                  aria-expanded={openMenu === "mode"}
                  aria-haspopup="menu"
                  onClick={() => toggleMenu("mode")}
                  title={getInteractionModeLabel(interactionMode, copy)}
                >
                  <span className="ai-workspace-command-trigger-icon">{renderInteractionModeIcon(interactionMode)}</span>
                  <span className="ai-workspace-command-trigger-copy">
                    <span className="ai-workspace-command-trigger-label">Mode</span>
                    <strong className="ai-workspace-command-trigger-value">{getInteractionModeLabel(interactionMode, copy)}</strong>
                  </span>
                  <ChevronDown className="w-3.5 h-3.5 ai-workspace-command-trigger-caret" />
                </button>
                {openMenu === "mode" && (
                  <div className="ai-workspace-command-popover" role="menu" aria-label="Choose chat mode">
                    {INTERACTION_MODES.map((mode) => {
                      return (
                        <button
                          key={mode}
                          type="button"
                          role="menuitemradio"
                          aria-checked={mode === interactionMode}
                          className={`ai-workspace-command-item ${mode === interactionMode ? "is-active" : ""}`}
                          onClick={() => {
                            setOpenMenu(null);
                            onSelectInteractionMode(mode);
                          }}
                        >
                          <span className="ai-workspace-command-item-icon">{renderInteractionModeIcon(mode)}</span>
                          <span className="ai-workspace-command-item-copy">
                            <strong>{getInteractionModeLabel(mode, copy)}</strong>
                            <span>{getInteractionModeHint(mode, copy)}</span>
                          </span>
                          {mode === interactionMode && <Check className="w-3.5 h-3.5 ai-workspace-command-item-check" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className={`ai-workspace-command-dropdown ai-workspace-command-dropdown--provider ${openMenu === "provider" ? "is-open" : ""}`}>
                <button
                  type="button"
                  className={`ai-workspace-command-trigger ai-workspace-command-trigger--provider ${openMenu === "provider" ? "is-active" : ""}`}
                  aria-expanded={openMenu === "provider"}
                  aria-haspopup="menu"
                  disabled={isSwitchingProvider}
                  onClick={() => toggleMenu("provider")}
                  title={activeProviderValue}
                >
                  <span className="ai-workspace-command-trigger-icon">
                    {isSwitchingProvider
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Sparkles className="w-3.5 h-3.5" />}
                  </span>
                  <span className="ai-workspace-command-trigger-copy">
                    <span className="ai-workspace-command-trigger-label">Model</span>
                    <strong className="ai-workspace-command-trigger-value">{activeProviderValue}</strong>
                    <span className="ai-workspace-command-trigger-note">{activeProviderCaption}</span>
                  </span>
                  <ChevronDown className="w-3.5 h-3.5 ai-workspace-command-trigger-caret" />
                </button>
                {openMenu === "provider" && (
                  <div className="ai-workspace-command-popover ai-workspace-command-popover--provider" role="menu" aria-label="Choose AI model">
                    <div className="ai-workspace-command-popover-head">
                      <strong>Switch model</strong>
                    </div>
                    <div className="ai-workspace-command-provider-list">
                      {providers.length > 0 ? providers.map((config) => {
                        const disabledModels = new Set(config.disabled_models ?? []);
                        const models = (config.models?.length
                          ? config.models
                          : (config.model?.trim() ? [config.model.trim()] : []))
                          .map((entry) => entry.trim())
                          .filter((entry) => Boolean(entry) && !disabledModels.has(entry));
                        // A provider whose whole catalog is disabled stays out of
                        // the switcher; re-enable it in settings.
                        if (models.length === 0 && (config.models?.length ?? 0) > 0) return null;
                        const typeLabel = formatAIProviderTypeLabel(config.provider_type);
                        const providerLabel = config.name?.trim() || typeLabel;
                        const isActiveProvider = config.id === activeProvider?.id;
                        const isExpanded = expandedProviderId === config.id;
                        const hasMultipleModels = models.length > 1;
                        const activeModelCaption = models.length === 0
                          ? typeLabel
                          : models.length === 1
                            ? models[0]
                            : models.includes(config.model)
                              ? config.model
                              : `${models.length} models`;
                        // Two-level menu: the provider row expands into its own
                        // model list instead of dumping every model in one flat wall.
                        return (
                          <Fragment key={config.id}>
                            <button
                              type="button"
                              role="menuitem"
                              aria-expanded={hasMultipleModels ? isExpanded : undefined}
                              className={`ai-workspace-command-item ai-workspace-command-item--provider ${isActiveProvider ? "is-active" : ""}`}
                              onClick={() => {
                                if (hasMultipleModels) {
                                  setExpandedProviderId(isExpanded ? null : config.id);
                                  return;
                                }
                                setOpenMenu(null);
                                onActivateProvider(config.id, models[0] || undefined);
                              }}
                            >
                              <span className="ai-workspace-command-item-copy">
                                <strong>{providerLabel}</strong>
                                <span>{activeModelCaption}</span>
                              </span>
                              <span className="ai-workspace-command-provider-meta">
                                {hasMultipleModels && (
                                  <ChevronDown className={`w-3.5 h-3.5 ai-workspace-command-model-chevron ${isExpanded ? "is-open" : ""}`} />
                                )}
                                {isActiveProvider && <Check className="w-3.5 h-3.5 ai-workspace-command-item-check" />}
                              </span>
                            </button>
                            {hasMultipleModels && isExpanded ? models.map((model) => {
                              const isActiveModel = isActiveProvider && config.model === model;
                              return (
                                <button
                                  key={`${config.id}:${model}`}
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={isActiveModel}
                                  className={`ai-workspace-command-item ai-workspace-command-model-item ${isActiveModel ? "is-active" : ""}`}
                                  onClick={() => {
                                    setOpenMenu(null);
                                    onActivateProvider(config.id, model);
                                  }}
                                >
                                  <span className="ai-workspace-command-item-copy">
                                    <strong>{model}</strong>
                                  </span>
                                  {isActiveModel && <Check className="w-3.5 h-3.5 ai-workspace-command-item-check" />}
                                </button>
                              );
                            }) : null}
                          </Fragment>
                        );
                      }) : (
                        <button type="button" className="ai-workspace-command-empty" onClick={onOpenSettings}>
                          No provider configured yet. Open settings
                        </button>
                      )}
                    </div>
                    {hiddenModelEntries.length > 0 ? (
                      <>
                        <button
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={showHiddenModels}
                          className="ai-workspace-command-item ai-workspace-command-hidden-toggle"
                          onClick={() => setShowHiddenModels((current) => !current)}
                        >
                          <span className="ai-workspace-command-item-copy">
                            <strong>{copy.composer.hiddenModelsToggle}</strong>
                          </span>
                          <ChevronDown className={`w-3.5 h-3.5 ai-workspace-command-model-chevron ${showHiddenModels ? "is-open" : ""}`} />
                        </button>
                        {showHiddenModels ? (
                          <div className="ai-workspace-command-hidden-list">
                            {hiddenModelEntries.map(({ config, model }) => (
                              <button
                                key={`${config.id}:${model}`}
                                type="button"
                                role="menuitem"
                                className="ai-workspace-command-item ai-workspace-command-model-item"
                                onClick={() => onToggleModelVisibility(config.id, model)}
                              >
                                <span className="ai-workspace-command-item-copy">
                                  <strong>{model}</strong>
                                  <span>{config.name?.trim() || formatAIProviderTypeLabel(config.provider_type)}</span>
                                </span>
                                <Eye className="w-3.5 h-3.5" />
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                    <button type="button" className="ai-workspace-command-settings-link" onClick={onOpenSettings}>
                      {copy.composer.openSettings}
                    </button>
                  </div>
                )}
              </div>

              <div className={`ai-workspace-command-dropdown ai-workspace-command-dropdown--utility ${openMenu === "utility" ? "is-open" : ""}`}>
                <button
                  type="button"
                  className={`ai-workspace-command-settings-btn ${openMenu === "utility" ? "is-active" : ""}`}
                  aria-expanded={openMenu === "utility"}
                  aria-haspopup="menu"
                  onClick={() => toggleMenu("utility")}
                  title="Chat tools"
                  aria-label="Chat tools"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                </button>
                {openMenu === "utility" && (
                  <div className="ai-workspace-command-popover ai-workspace-command-popover--utility" role="menu" aria-label="Chat tools">
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={isSessionDataReadEnabled}
                      className={`ai-workspace-command-utility-item ${isSessionDataReadEnabled ? "is-active" : ""}`}
                      onClick={() => onSetSessionDataReadEnabled(!isSessionDataReadEnabled)}
                      disabled={!isConnectionAvailable}
                    >
                      <span className="ai-workspace-command-utility-icon"><Database className="w-3.5 h-3.5" /></span>
                      <span className="ai-workspace-command-utility-copy">
                        <strong>{sessionDataReadLabel}</strong>
                        <span>{sessionDataReadTitle}</span>
                      </span>
                      {isSessionDataReadEnabled && <Check className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={autoSwitchEnabled}
                      className={`ai-workspace-command-utility-item ${autoSwitchEnabled ? "is-active" : ""}`}
                      onClick={() => setAIFailoverConsent(autoSwitchEnabled ? "declined" : "approved")}
                    >
                      <span className="ai-workspace-command-utility-icon"><ArrowLeftRight className="w-3.5 h-3.5" /></span>
                      <span className="ai-workspace-command-utility-copy">
                        <strong>{copy.composer.autoProviderSwitchLabel}</strong>
                        <span>{autoSwitchEnabled ? copy.composer.thinkingOn : copy.composer.thinkingOff}</span>
                      </span>
                      {autoSwitchEnabled && <Check className="w-3.5 h-3.5" />}
                    </button>
                    {interactionMode === "agent" && (
                      <>
                        <button
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={showThinking}
                          className={`ai-workspace-command-utility-item ${showThinking ? "is-active" : ""}`}
                          onClick={() => onSetShowThinking(!showThinking)}
                        >
                          <span className="ai-workspace-command-utility-icon"><Brain className="w-3.5 h-3.5" /></span>
                          <span className="ai-workspace-command-utility-copy">
                            <strong>{copy.composer.thinkingToggleLabel}</strong>
                            <span>{showThinking ? copy.composer.thinkingOn : copy.composer.thinkingOff}</span>
                          </span>
                          {showThinking && <Check className="w-3.5 h-3.5" />}
                        </button>
                        <div className="ai-workspace-command-utility-divider" role="separator" />
                        <div className="ai-workspace-command-utility-section-label">
                          {copy.composer.agentAutonomyLabel}
                        </div>
                        {AGENT_AUTONOMY_OPTIONS.map((autonomy) => (
                          <button
                            key={autonomy}
                            type="button"
                            role="menuitemradio"
                            aria-checked={autonomy === agentAutonomy}
                            className={`ai-workspace-command-utility-item ${autonomy === agentAutonomy ? "is-active" : ""}`}
                            onClick={() => onSelectAgentAutonomy(autonomy)}
                          >
                            <span className="ai-workspace-command-utility-icon">{renderAgentAutonomyIcon(autonomy)}</span>
                            <span className="ai-workspace-command-utility-copy">
                              <strong>{getAgentAutonomyLabel(autonomy, copy)}</strong>
                              <span>{getAgentAutonomyHint(autonomy, copy)}</span>
                            </span>
                            {autonomy === agentAutonomy && <Check className="w-3.5 h-3.5" />}
                          </button>
                        ))}
                        <div className="ai-workspace-command-utility-divider" role="separator" />
                      </>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      className="ai-workspace-command-utility-item"
                      onClick={() => {
                        setOpenMenu(null);
                        onOpenSettings();
                      }}
                    >
                      <span className="ai-workspace-command-utility-icon"><Settings2 className="w-3.5 h-3.5" /></span>
                      <span className="ai-workspace-command-utility-copy"><strong>{copy.composer.openSettings}</strong></span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            className={`ai-workspace-generate-btn ${isGenerating || isCancelling ? "is-cancel" : ""}`}
            onClick={isGenerating ? onCancelGeneration : onGenerate}
            disabled={isCancelling || (!isGenerating && (!prompt.trim() && !hasAttachedSelectionText))}
            aria-label={
              isCancelling
                ? copy.composer.cancelling
                : isGenerating
                  ? copy.composer.cancelGeneration
                  : copy.composer.generateBubble
            }
            title={
              isCancelling
                ? copy.composer.cancelling
                : isGenerating
                  ? copy.composer.cancelGeneration
                  : copy.composer.generateBubble
            }
          >
            {isCancelling
              ? <Loader2 className="w-[18px] h-[18px] animate-spin" />
              : isGenerating
                ? <Square className="w-[18px] h-[18px]" />
              : <ArrowUp className="w-[18px] h-[18px]" />}
          </button>
        </div>
      </div>
    </div>
  );
}
