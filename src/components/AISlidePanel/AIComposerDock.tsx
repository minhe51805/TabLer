import {
  ArrowUp,
  Check,
  ChevronDown,
  FileText,
  Loader2,
  MessageSquare,
  Paperclip,
  PencilLine,
  SlidersHorizontal,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEventHandler,
  type ClipboardEvent,
  type RefObject,
} from "react";
import { formatTokensCompact } from "../../utils/ai-context-compact";
import type { AIProviderConfig } from "../../types";
import { getAIFailoverConsent, setAIFailoverConsent } from "../../utils/ai-failover-consent";
import { formatAIProviderTypeLabel } from "../../utils/ai-provider-registry";
import { formatAttachmentBytes, type AIAttachmentDraft } from "../../utils/ai-attachments";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";
import { AISlashCommandMenu } from "./AISlashCommandMenu";
import { ConfirmDialog } from "../ConfirmDialog";
import type { AISlashCommand } from "./ai-slash-commands";
import type { AIWorkspaceAgentAutonomy, AIWorkspaceInteractionMode } from "./ai-workspace-types";
import type { SandboxPolicy } from "./ai-execution-policy";
import { formatPanelCopy, getAIPanelCopy } from "./ai-panel-copy";
import { useI18n } from "../../i18n";
import { AIComposerProviderMenu, AIComposerUtilityMenu } from "./AIComposerMenus";

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
  /** Sends parked while a run is in flight; the chip lets the user drop them. */
  pendingQueueCount?: number;
  onClearPendingQueue?: () => void;
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
  /** Effective sandbox posture (Safe Mode level + autonomy), shown as a badge. */
  sandboxPolicy?: SandboxPolicy;
  /** Flip the global Safe Mode level between 0 (off) and 1 (read-only). */
  onToggleSafeMode?: (next: boolean) => void;
  onCloseHistory: () => void;
  onGenerate: () => void;
  onCancelGeneration: () => void;
  contextUsage?: { used: number; limit: number };
  /** Draft attachments waiting to be sent with the next message. */
  attachments?: AIAttachmentDraft[];
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
  pendingQueueCount = 0,
  onClearPendingQueue,
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
  sandboxPolicy,
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
  const { language } = useI18n();
  const panelCopy = getAIPanelCopy(language);

  const [openMenu, setOpenMenu] = useState<ComposerMenu | null>(null);
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [showHiddenModels, setShowHiddenModels] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const commandBarRef = useRef<HTMLDivElement>(null);
  const effectiveContextUsage = contextUsage ?? { used: 0, limit: 24_000 };
  const usagePercent =
    effectiveContextUsage.limit > 0
      ? Math.min(100, Math.round((effectiveContextUsage.used / effectiveContextUsage.limit) * 100))
      : 0;
  const contextMeterState =
    usagePercent >= 90 ? "is-critical" : usagePercent >= 70 ? "is-warn" : "";
  const activeProviderValue =
    activeProvider?.model?.trim() || activeProvider?.name?.trim() || copy.composer.noProvider;
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
    setOpenMenu((current) => (current === menu ? null : menu));
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

  const hiddenModelEntries = providers.flatMap((config) =>
    (config.disabled_models ?? [])
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((model) => ({ config, model })),
  );

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

  // Guard the utility toggles (Data read, auto provider switch, Thinking)
  // behind a confirmation dialog so an accidental tap never silently flips
  // them. The pending change is applied only after the user confirms.
  const [pendingToggle, setPendingToggle] = useState<{
    kind: "data" | "autoSwitch" | "thinking";
    next: boolean;
  } | null>(null);

  const requestToggle = (kind: "data" | "autoSwitch" | "thinking", next: boolean) => {
    setPendingToggle({ kind, next });
  };

  const applyPendingToggle = () => {
    if (!pendingToggle) return;
    const { kind, next } = pendingToggle;
    if (kind === "data") onSetSessionDataReadEnabled(next);
    else if (kind === "autoSwitch") setAIFailoverConsent(next ? "approved" : "declined");
    else onSetShowThinking(next);
    setPendingToggle(null);
  };

  const pendingToggleFeatureLabel = pendingToggle
    ? pendingToggle.kind === "data"
      ? copy.composer.dataReadToggleLabel
      : pendingToggle.kind === "autoSwitch"
        ? copy.composer.autoProviderSwitchLabel
        : copy.composer.thinkingToggleLabel
    : "";
  const pendingToggleMessage = pendingToggle
    ? (pendingToggle.next
        ? copy.composer.toggleConfirmMessageEnable
        : copy.composer.toggleConfirmMessageDisable
      ).replace("{feature}", pendingToggleFeatureLabel)
    : "";

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
            <div
              key={attachment.id}
              className={`ai-workspace-attachment-chip ${attachment.kind === "image" ? "is-image" : "is-file"}`}
            >
              {attachment.kind === "image" && attachment.dataUrl ? (
                <img
                  className="ai-workspace-attachment-thumb"
                  src={attachment.dataUrl}
                  alt={attachment.name}
                />
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
            <span className="ai-workspace-selection-chip-kicker">
              {copy.composer.selectionReady}
            </span>
            <strong className="ai-workspace-selection-chip-title">{attachedSelectionSource}</strong>
          </div>
          <button
            type="button"
            className="ai-workspace-selection-chip-dismiss"
            onClick={onDismissSelection}
          >
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
        {pendingQueueCount > 0 && (
          <div className="ai-workspace-queue-chip" role="status">
            <span>
              {formatPanelCopy(panelCopy.responseActions.queuedCount, {
                count: String(pendingQueueCount),
              })}
            </span>
            {onClearPendingQueue && (
              <button
                type="button"
                className="ai-workspace-queue-chip-clear"
                onClick={onClearPendingQueue}
              >
                {panelCopy.responseActions.queuedClear}
              </button>
            )}
          </div>
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
          <div
            className={`ai-workspace-context-meter ${contextMeterState}`}
            title={`${copy.workspace.contextBadge} · ${usagePercent}% — estimated tokens (~4 chars/token) · each request sends digest + last messages only`}
          >
            <span className="ai-workspace-context-meter-value">
              {formatTokensCompact(effectiveContextUsage.used)}
            </span>
            <div className="ai-workspace-context-meter-track">
              <div
                className="ai-workspace-context-meter-fill"
                style={{ width: `${Math.max(2, usagePercent)}%` }}
              />
            </div>
            <span className="ai-workspace-context-meter-limit">
              {formatTokensCompact(effectiveContextUsage.limit)}
            </span>
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
              <div
                className={`ai-workspace-command-dropdown ${openMenu === "mode" ? "is-open" : ""}`}
              >
                <button
                  type="button"
                  className={`ai-workspace-command-trigger ${openMenu === "mode" ? "is-active" : ""}`}
                  aria-expanded={openMenu === "mode"}
                  aria-haspopup="menu"
                  onClick={() => toggleMenu("mode")}
                  title={getInteractionModeLabel(interactionMode, copy)}
                >
                  <span className="ai-workspace-command-trigger-icon">
                    {renderInteractionModeIcon(interactionMode)}
                  </span>
                  <span className="ai-workspace-command-trigger-copy">
                    <span className="ai-workspace-command-trigger-label">Mode</span>
                    <strong className="ai-workspace-command-trigger-value">
                      {getInteractionModeLabel(interactionMode, copy)}
                    </strong>
                  </span>
                  <ChevronDown className="w-3.5 h-3.5 ai-workspace-command-trigger-caret" />
                </button>
                {openMenu === "mode" && (
                  <div
                    className="ai-workspace-command-popover"
                    role="menu"
                    aria-label="Choose chat mode"
                  >
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
                          <span className="ai-workspace-command-item-icon">
                            {renderInteractionModeIcon(mode)}
                          </span>
                          <span className="ai-workspace-command-item-copy">
                            <strong>{getInteractionModeLabel(mode, copy)}</strong>
                            <span className="ai-workspace-command-item-hint">
                              {getInteractionModeHint(mode, copy)}
                            </span>
                          </span>
                          {mode === interactionMode && (
                            <Check className="w-3.5 h-3.5 ai-workspace-command-item-check" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div
                className={`ai-workspace-command-dropdown ai-workspace-command-dropdown--provider ${openMenu === "provider" ? "is-open" : ""}`}
              >
                <button
                  type="button"
                  className={`ai-workspace-command-trigger ai-workspace-command-trigger--provider ${openMenu === "provider" ? "is-active" : ""}`}
                  aria-expanded={openMenu === "provider"}
                  aria-haspopup="menu"
                  onClick={() => toggleMenu("provider")}
                  title={activeProviderValue}
                >
                  <span className="ai-workspace-command-trigger-icon">
                    {isSwitchingProvider ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5" />
                    )}
                  </span>
                  <span className="ai-workspace-command-trigger-copy">
                    <span className="ai-workspace-command-trigger-label">Model</span>
                    <strong className="ai-workspace-command-trigger-value">
                      {activeProviderValue}
                    </strong>
                    <span className="ai-workspace-command-trigger-note">
                      {activeProviderCaption}
                    </span>
                  </span>
                  <ChevronDown className="w-3.5 h-3.5 ai-workspace-command-trigger-caret" />
                </button>
                {openMenu === "provider" && (
                  <AIComposerProviderMenu
                    providers={providers}
                    activeProvider={activeProvider}
                    expandedProviderId={expandedProviderId}
                    showHiddenModels={showHiddenModels}
                    hiddenModelEntries={hiddenModelEntries}
                    safeModeEnabled={safeModeEnabled}
                    sandboxPolicy={sandboxPolicy}
                    copy={copy}
                    onActivateProvider={onActivateProvider}
                    onToggleModelVisibility={onToggleModelVisibility}
                    onOpenSettings={onOpenSettings}
                    onToggleSafeMode={onToggleSafeMode}
                    setExpandedProviderId={setExpandedProviderId}
                    setShowHiddenModels={setShowHiddenModels}
                    closeMenu={() => setOpenMenu(null)}
                  />
                )}
              </div>

              <div
                className={`ai-workspace-command-dropdown ai-workspace-command-dropdown--utility ${openMenu === "utility" ? "is-open" : ""}`}
              >
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
                  <AIComposerUtilityMenu
                    isSessionDataReadEnabled={isSessionDataReadEnabled}
                    sessionDataReadLabel={sessionDataReadLabel}
                    sessionDataReadTitle={sessionDataReadTitle}
                    autoSwitchEnabled={autoSwitchEnabled}
                    interactionMode={interactionMode}
                    showThinking={showThinking}
                    agentAutonomy={agentAutonomy}
                    isConnectionAvailable={isConnectionAvailable}
                    copy={copy}
                    requestToggle={requestToggle}
                    onSelectAgentAutonomy={onSelectAgentAutonomy}
                    onOpenAttachmentManager={onOpenAttachmentManager}
                    onOpenSettings={onOpenSettings}
                    closeMenu={() => setOpenMenu(null)}
                  />
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            className={`ai-workspace-generate-btn ${isGenerating || isCancelling ? "is-cancel" : ""}`}
            onClick={isGenerating ? onCancelGeneration : onGenerate}
            disabled={
              isCancelling ||
              (!isGenerating &&
                !prompt.trim() &&
                !hasAttachedSelectionText &&
                attachments.length === 0)
            }
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
            {isCancelling ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : isGenerating ? (
              <Square className="w-3.5 h-3.5" />
            ) : (
              <ArrowUp className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>
      <ConfirmDialog
        isOpen={pendingToggle !== null}
        title={copy.composer.toggleConfirmTitle}
        message={pendingToggleMessage}
        confirmText={copy.composer.toggleConfirmConfirm}
        cancelText={copy.composer.toggleConfirmCancel}
        onConfirm={applyPendingToggle}
        onCancel={() => setPendingToggle(null)}
      />
    </div>
  );
}
