import {
  ArrowLeftRight,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  Database,
  Eye,
  FileText,
  Loader2,
  MessageSquare,
  Paperclip,
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
import { Fragment, useEffect, useRef, useState, type DragEvent, type KeyboardEventHandler, type ClipboardEvent, type RefObject } from "react";
import type { AIProviderConfig } from "../../types";
import { formatAIProviderTypeLabel } from "../../utils/ai-provider-registry";
import { getAIFailoverConsent, setAIFailoverConsent } from "../../utils/ai-failover-consent";
import { formatAttachmentBytes, type AIAttachmentDraft } from "../../utils/ai-attachments";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";
import { AISlashCommandMenu } from "./AISlashCommandMenu";
import type { AISlashCommand } from "./ai-slash-commands";
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
  /** Whether Safe Mode is currently enabled (level >= 1). */
  safeModeEnabled?: boolean;
  /** Flip the global Safe Mode level between 0 (off) and 1 (read-only). */
  onToggleSafeMode?: (next: boolean) => void;
  onCloseHistory: () => void;
  onGenerate: () => void;
  onCancelGeneration: () => void;
  contextUsage?: { used: number; limit: number };
  /** Draft attachments waiting to be sent with the next message. */
  attachments?: AIAttachmentDraft[];
  /** Whether the active model advertises image input (`input_types`). */
  canAttachImages?: boolean;
  onAddAttachmentFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  onOpenAttachmentManager?: () => void;
  /** Open "/" command menu state; null keeps the menu hidden. */
  slashMenu?: {
    commands: AISlashCommand[];
    activeIndex: number;
  } | null;
  onSelectSlashCommand?: (name: string) => void;
}

type ComposerMenu = "mode" | "provider" | "utility";

const INTERACTION_MODES: AIWorkspaceInteractionMode[] = ["prompt", "edit", "agent"];
const AGENT_AUTONOMY_OPTIONS: AIWorkspaceAgentAutonomy[] = ["review", "smart", "full"];

function formatContextChars(chars: number) {
  if (chars >= 1_000_000) {
    const millions = chars / 1_000_000;
    return `${millions >= 10 || Number.isInteger(millions) ? Math.round(millions) : millions.toFixed(1)}M`;
  }
  if (chars >= 1_000) {
    const thousands = chars / 1_000;
    return `${thousands >= 10 || Number.isInteger(thousands) ? Math.round(thousands) : thousands.toFixed(1)}k`;
  }
  return String(chars);
}

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
  safeModeEnabled,
  onToggleSafeMode,
  onCloseHistory,
  onGenerate,
  onCancelGeneration,
  contextUsage,
  attachments = [],
  onAddAttachmentFiles = () => {},
  onRemoveAttachment = () => {},
  onOpenAttachmentManager = () => {},
  slashMenu = null,
  onSelectSlashCommand,
}: AIComposerDockProps) {
  const [openMenu, setOpenMenu] = useState<ComposerMenu | null>(null);
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [showHiddenModels, setShowHiddenModels] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const commandBarRef = useRef<HTMLDivElement>(null);
  const effectiveContextUsage = contextUsage ?? { used: 0, limit: 24_000 };
  const usagePercent = effectiveContextUsage.limit > 0
    ? Math.min(100, Math.round((effectiveContextUsage.used / effectiveContextUsage.limit) * 100))
    : 0;
  const contextMeterState = usagePercent >= 90
    ? "is-critical"
    : usagePercent >= 70
      ? "is-warn"
      : "";
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
    <div
      className={`ai-workspace-compose-dock ${isDragOver ? "is-dragover" : ""}`}
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setIsDragOver(false);
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length > 0) onAddAttachmentFiles(files);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="ai-workspace-attachment-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) onAddAttachmentFiles(files);
          event.target.value = "";
        }}
      />
      {attachments.length > 0 && (
        <div className="ai-workspace-attachment-row">
          {attachments.map((attachment) => (
            <div key={attachment.id} className={`ai-workspace-attachment-chip ${attachment.kind === "image" ? "is-image" : "is-file"}`}>
              {attachment.kind === "image" && attachment.dataUrl ? (
                <img className="ai-workspace-attachment-thumb" src={attachment.dataUrl} alt={attachment.name} />
              ) : (
                <FileText className="w-3.5 h-3.5 ai-workspace-attachment-kind-icon" />
              )}
              <span className="ai-workspace-attachment-chip-copy">
                <strong title={attachment.name}>{attachment.name}</strong>
                <span>{formatAttachmentBytes(attachment.size)}</span>
              </span>
              <button
                type="button"
                className="ai-workspace-attachment-chip-dismiss"
                onClick={() => onRemoveAttachment(attachment.id)}
                title={copy.attachments.removeAttachment}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
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
        {slashMenu && onSelectSlashCommand && (
          <AISlashCommandMenu
            title={copy.composer.slashCommandsTitle}
            emptyHint={copy.composer.slashNoMatch}
            query={prompt.replace(/^\//, "")}
            commands={slashMenu.commands}
            activeIndex={slashMenu.activeIndex}
            onSelect={onSelectSlashCommand}
          />
        )}
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (files.length > 0) {
              event.preventDefault();
              onAddAttachmentFiles(files);
            }
          }}
          className="ai-workspace-composer-textarea"
          placeholder={copy.composer.placeholder}
        />

        <div className="ai-workspace-meter-row">
          <button
            type="button"
            className="ai-workspace-attach-btn"
            onClick={() => fileInputRef.current?.click()}
            title={copy.attachments.attachButton}
            aria-label={copy.attachments.attachButton}
          >
            <Paperclip className="w-3.5 h-3.5" />
          </button>
          <div className={`ai-workspace-context-meter ${contextMeterState}`} title={`${copy.workspace.contextBadge} · ${usagePercent}% — conversation footprint; each request sends the digest + last messages only`}>
            <span className="ai-workspace-context-meter-value">{formatContextChars(effectiveContextUsage.used)}</span>
            <div className="ai-workspace-context-meter-track">
              <div className="ai-workspace-context-meter-fill" style={{ width: `${Math.max(2, usagePercent)}%` }} />
            </div>
            <span className="ai-workspace-context-meter-limit">{formatContextChars(effectiveContextUsage.limit)}</span>
          </div>
        </div>

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
                            <span className="ai-workspace-command-item-hint">{getInteractionModeHint(mode, copy)}</span>
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
                    {onToggleSafeMode && (
                      <div className="ai-workspace-command-safemode" role="group" aria-label={copy.composer.safeModeToggle}>
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>{copy.composer.safeModeToggle}</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={safeModeEnabled}
                          aria-label={copy.composer.safeModeToggle}
                          className={`ai-ws-safemode-switch ${safeModeEnabled ? "is-on" : ""}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleSafeMode(!safeModeEnabled);
                          }}
                        >
                          <span className="ai-ws-safemode-knob" />
                        </button>
                      </div>
                    )}
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
                        onOpenAttachmentManager();
                      }}
                    >
                      <span className="ai-workspace-command-utility-icon"><Paperclip className="w-3.5 h-3.5" /></span>
                      <span className="ai-workspace-command-utility-copy"><strong>{copy.attachments.managerOpen}</strong></span>
                    </button>
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
            disabled={isCancelling || (!isGenerating && !prompt.trim() && !hasAttachedSelectionText && attachments.length === 0)}
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
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : isGenerating
                ? <Square className="w-3.5 h-3.5" />
              : <ArrowUp className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
