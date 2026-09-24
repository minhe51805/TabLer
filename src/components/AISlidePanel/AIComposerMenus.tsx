import {
  ArrowLeftRight,
  Brain,
  Check,
  ChevronDown,
  Database,
  Eye,
  Paperclip,
  Settings2,
  Shield,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { Fragment } from "react";
import type { AIProviderConfig } from "../../types";
import { formatAIProviderTypeLabel } from "../../utils/ai-provider-registry";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";
import type { AIWorkspaceAgentAutonomy, AIWorkspaceInteractionMode } from "./ai-workspace-types";
import { describeSandboxPolicy, type SandboxPolicy } from "./ai-execution-policy";

const AGENT_AUTONOMY_OPTIONS: AIWorkspaceAgentAutonomy[] = ["review", "smart", "full"];

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

/** Model/provider switcher popover: two-level provider -> model list plus the
 *  hidden-models reveal, safe-mode switch, and sandbox badge. */
export function AIComposerProviderMenu({
  providers,
  activeProvider,
  expandedProviderId,
  showHiddenModels,
  hiddenModelEntries,
  safeModeEnabled,
  sandboxPolicy,
  copy,
  onActivateProvider,
  onToggleModelVisibility,
  onOpenSettings,
  onToggleSafeMode,
  setExpandedProviderId,
  setShowHiddenModels,
  closeMenu,
}: {
  providers: AIProviderConfig[];
  activeProvider: AIProviderConfig | undefined;
  expandedProviderId: string | null;
  showHiddenModels: boolean;
  hiddenModelEntries: { config: AIProviderConfig; model: string }[];
  safeModeEnabled?: boolean;
  sandboxPolicy?: SandboxPolicy;
  copy: AIWorkspaceCopy;
  onActivateProvider: (providerId: string, model?: string) => void;
  onToggleModelVisibility: (providerId: string, model: string) => void;
  onOpenSettings: () => void;
  onToggleSafeMode?: (next: boolean) => void;
  setExpandedProviderId: (id: string | null) => void;
  setShowHiddenModels: (next: boolean | ((current: boolean) => boolean)) => void;
  closeMenu: () => void;
}) {
  return (
    <div
      className="ai-workspace-command-popover ai-workspace-command-popover--provider"
      role="menu"
      aria-label="Choose AI model"
    >
      <div className="ai-workspace-command-popover-head">
        <strong>Switch model</strong>
      </div>
      <div className="ai-workspace-command-provider-list">
        {providers.length > 0 ? (
          providers.map((config) => {
            const disabledModels = new Set(config.disabled_models ?? []);
            const models = (
              config.models?.length
                ? config.models
                : config.model?.trim()
                  ? [config.model.trim()]
                  : []
            )
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
            const activeModelCaption =
              models.length === 0
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
                    closeMenu();
                    onActivateProvider(config.id, models[0] || undefined);
                  }}
                >
                  <span className="ai-workspace-command-item-copy">
                    <strong>{providerLabel}</strong>
                    <span>{activeModelCaption}</span>
                  </span>
                  <span className="ai-workspace-command-provider-meta">
                    {hasMultipleModels && (
                      <ChevronDown
                        className={`w-3.5 h-3.5 ai-workspace-command-model-chevron ${isExpanded ? "is-open" : ""}`}
                      />
                    )}
                    {isActiveProvider && (
                      <Check className="w-3.5 h-3.5 ai-workspace-command-item-check" />
                    )}
                  </span>
                </button>
                {hasMultipleModels && isExpanded
                  ? models.map((model) => {
                      const isActiveModel = isActiveProvider && config.model === model;
                      return (
                        <button
                          key={`${config.id}:${model}`}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isActiveModel}
                          className={`ai-workspace-command-item ai-workspace-command-model-item ${isActiveModel ? "is-active" : ""}`}
                          onClick={() => {
                            closeMenu();
                            onActivateProvider(config.id, model);
                          }}
                        >
                          <span className="ai-workspace-command-item-copy">
                            <strong>{model}</strong>
                          </span>
                          {isActiveModel && (
                            <Check className="w-3.5 h-3.5 ai-workspace-command-item-check" />
                          )}
                        </button>
                      );
                    })
                  : null}
              </Fragment>
            );
          })
        ) : (
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
            <ChevronDown
              className={`w-3.5 h-3.5 ai-workspace-command-model-chevron ${showHiddenModels ? "is-open" : ""}`}
            />
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
                    <span>
                      {config.name?.trim() || formatAIProviderTypeLabel(config.provider_type)}
                    </span>
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
        <div
          className="ai-workspace-command-safemode"
          role="group"
          aria-label={copy.composer.safeModeToggle}
        >
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
      {sandboxPolicy && (
        <div
          className="ai-workspace-command-sandbox-policy"
          title={describeSandboxPolicy(sandboxPolicy).description}
        >
          <Shield className="w-3.5 h-3.5" />
          <span>Sandbox: {describeSandboxPolicy(sandboxPolicy).label}</span>
        </div>
      )}
    </div>
  );
}

/** "Chat tools" popover: session data read, provider auto-switch, thinking
 *  trace, agent autonomy, attachment manager, and settings shortcuts. */
export function AIComposerUtilityMenu({
  isSessionDataReadEnabled,
  sessionDataReadLabel,
  sessionDataReadTitle,
  autoSwitchEnabled,
  interactionMode,
  showThinking,
  agentAutonomy,
  isConnectionAvailable,
  copy,
  requestToggle,
  onSelectAgentAutonomy,
  onOpenAttachmentManager,
  onOpenSettings,
  closeMenu,
}: {
  isSessionDataReadEnabled: boolean;
  sessionDataReadLabel: string;
  sessionDataReadTitle: string;
  autoSwitchEnabled: boolean;
  interactionMode: AIWorkspaceInteractionMode;
  showThinking: boolean;
  agentAutonomy: AIWorkspaceAgentAutonomy;
  isConnectionAvailable: boolean;
  copy: AIWorkspaceCopy;
  requestToggle: (kind: "data" | "autoSwitch" | "thinking", next: boolean) => void;
  onSelectAgentAutonomy: (autonomy: AIWorkspaceAgentAutonomy) => void;
  onOpenAttachmentManager: () => void;
  onOpenSettings: () => void;
  closeMenu: () => void;
}) {
  return (
    <div
      className="ai-workspace-command-popover ai-workspace-command-popover--utility"
      role="menu"
      aria-label="Chat tools"
    >
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={isSessionDataReadEnabled}
        className={`ai-workspace-command-utility-item ${isSessionDataReadEnabled ? "is-active" : ""}`}
        onClick={() => requestToggle("data", !isSessionDataReadEnabled)}
        disabled={!isConnectionAvailable}
      >
        <span className="ai-workspace-command-utility-icon">
          <Database className="w-3.5 h-3.5" />
        </span>
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
        onClick={() => requestToggle("autoSwitch", !autoSwitchEnabled)}
      >
        <span className="ai-workspace-command-utility-icon">
          <ArrowLeftRight className="w-3.5 h-3.5" />
        </span>
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
            onClick={() => requestToggle("thinking", !showThinking)}
          >
            <span className="ai-workspace-command-utility-icon">
              <Brain className="w-3.5 h-3.5" />
            </span>
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
              <span className="ai-workspace-command-utility-icon">
                {renderAgentAutonomyIcon(autonomy)}
              </span>
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
          closeMenu();
          onOpenAttachmentManager();
        }}
      >
        <span className="ai-workspace-command-utility-icon">
          <Paperclip className="w-3.5 h-3.5" />
        </span>
        <span className="ai-workspace-command-utility-copy">
          <strong>{copy.attachments.managerOpen}</strong>
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="ai-workspace-command-utility-item"
        onClick={() => {
          closeMenu();
          onOpenSettings();
        }}
      >
        <span className="ai-workspace-command-utility-icon">
          <Settings2 className="w-3.5 h-3.5" />
        </span>
        <span className="ai-workspace-command-utility-copy">
          <strong>{copy.composer.openSettings}</strong>
        </span>
      </button>
    </div>
  );
}
