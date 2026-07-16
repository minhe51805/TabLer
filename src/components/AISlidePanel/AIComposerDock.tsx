import {
  Brain,
  Check,
  ChevronDown,
  Database,
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
import { useEffect, useRef, useState, type KeyboardEventHandler, type RefObject } from "react";
import type { AIProviderConfig } from "../../types";
import { formatAIProviderTypeLabel } from "../../utils/ai-provider-registry";
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
  onActivateProvider: (providerId: string) => void;
  onSetSessionDataReadEnabled: (enabled: boolean) => void;
  onSetShowThinking: (show: boolean) => void;
  onOpenSettings: () => void;
  onCloseHistory: () => void;
  onGenerate: () => void;
  onCancelGeneration: () => void;
}

type ComposerMenu = "mode" | "autonomy" | "provider" | "utility";

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
  onSetSessionDataReadEnabled,
  onSetShowThinking,
  onOpenSettings,
  onCloseHistory,
  onGenerate,
  onCancelGeneration,
}: AIComposerDockProps) {
  const [openMenu, setOpenMenu] = useState<ComposerMenu | null>(null);
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

              {interactionMode === "agent" && (
                <div className={`ai-workspace-command-dropdown ai-workspace-command-dropdown--autonomy ${openMenu === "autonomy" ? "is-open" : ""}`}>
                  <button
                    type="button"
                    className={`ai-workspace-command-trigger ${openMenu === "autonomy" ? "is-active" : ""}`}
                    aria-expanded={openMenu === "autonomy"}
                    aria-haspopup="menu"
                    onClick={() => toggleMenu("autonomy")}
                    title={getAgentAutonomyLabel(agentAutonomy, copy)}
                  >
                    <span className="ai-workspace-command-trigger-icon">{renderAgentAutonomyIcon(agentAutonomy)}</span>
                    <span className="ai-workspace-command-trigger-copy">
                      <span className="ai-workspace-command-trigger-label">{copy.composer.agentAutonomyLabel}</span>
                      <strong className="ai-workspace-command-trigger-value">{getAgentAutonomyLabel(agentAutonomy, copy)}</strong>
                    </span>
                    <ChevronDown className="w-3.5 h-3.5 ai-workspace-command-trigger-caret" />
                  </button>
                  {openMenu === "autonomy" && (
                    <div className="ai-workspace-command-popover" role="menu" aria-label={copy.composer.agentAutonomyLabel}>
                      {AGENT_AUTONOMY_OPTIONS.map((autonomy) => {
                        return (
                          <button
                            key={autonomy}
                            type="button"
                            role="menuitemradio"
                            aria-checked={autonomy === agentAutonomy}
                            className={`ai-workspace-command-item ${autonomy === agentAutonomy ? "is-active" : ""}`}
                            onClick={() => {
                              setOpenMenu(null);
                              onSelectAgentAutonomy(autonomy);
                            }}
                          >
                            <span className="ai-workspace-command-item-icon">{renderAgentAutonomyIcon(autonomy)}</span>
                            <span className="ai-workspace-command-item-copy">
                              <strong>{getAgentAutonomyLabel(autonomy, copy)}</strong>
                              <span>{getAgentAutonomyHint(autonomy, copy)}</span>
                            </span>
                            {autonomy === agentAutonomy && <Check className="w-3.5 h-3.5 ai-workspace-command-item-check" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

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
                      <span>Switch the active AI provider without leaving the chat panel.</span>
                    </div>
                    <div className="ai-workspace-command-provider-list">
                      {providers.length > 0 ? providers.map((config) => {
                        const providerValue = config.model?.trim()
                          || config.name?.trim()
                          || formatAIProviderTypeLabel(config.provider_type);
                        const providerCaption = config.name?.trim() && config.name.trim() !== providerValue
                          ? `${config.name.trim()} / ${formatAIProviderTypeLabel(config.provider_type)}`
                          : formatAIProviderTypeLabel(config.provider_type);
                        return (
                          <button
                            key={config.id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={config.id === activeProvider?.id}
                            className={`ai-workspace-command-item ai-workspace-command-item--provider ${config.id === activeProvider?.id ? "is-active" : ""}`}
                            onClick={() => {
                              setOpenMenu(null);
                              onActivateProvider(config.id);
                            }}
                          >
                            <span className="ai-workspace-command-item-copy">
                              <strong>{providerValue}</strong>
                              <span>{providerCaption}</span>
                            </span>
                            <span className="ai-workspace-command-provider-meta">
                              {!config.is_enabled && <span className="ai-workspace-command-provider-tag">Disabled</span>}
                              {config.id === activeProvider?.id && <Check className="w-3.5 h-3.5 ai-workspace-command-item-check" />}
                            </span>
                          </button>
                        );
                      }) : (
                        <button type="button" className="ai-workspace-command-empty" onClick={onOpenSettings}>
                          No provider configured yet. Open settings
                        </button>
                      )}
                    </div>
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
                    {interactionMode === "agent" && (
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
          >
            {isCancelling
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : isGenerating
                ? <Square className="w-4 h-4" />
              : <Sparkles className="w-4 h-4" />}
            {isCancelling
              ? copy.composer.cancelling
              : isGenerating ? copy.composer.cancelGeneration
              : copy.composer.generateBubble}
          </button>
        </div>
      </div>
    </div>
  );
}
