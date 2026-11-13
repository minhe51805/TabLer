import { useMemo, type KeyboardEventHandler, type RefObject } from "react";
import type { AIProviderConfig } from "../../types";
import { estimateTokensFromChars } from "../../utils/ai-context-compact";
import { AIComposerDock } from "./AIComposerDock";
import type { SandboxPolicy } from "./ai-execution-policy";
import type { AISlashCommand } from "./ai-slash-commands";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";
import type { AIWorkspaceAgentAutonomy, AIWorkspaceInteractionMode } from "./ai-workspace-types";
import { useAIPanelStore } from "./store/aiPanelStore";

export interface AIComposerDockConnectedProps {
  copy: AIWorkspaceCopy;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  baseContextChars: number;
  contextLimitTokens: number;
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
  safeModeEnabled?: boolean;
  sandboxPolicy?: SandboxPolicy;
  onToggleSafeMode?: (next: boolean) => void;
  onCloseHistory: () => void;
  onGenerate: () => void;
  onCancelGeneration: () => void;
  onClearPendingQueue?: () => void;
  onAddAttachmentFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  onOpenAttachmentManager?: () => void;
  slashMenu?: {
    commands: AISlashCommand[];
    activeIndex: number;
  } | null;
  onSelectSlashCommand?: (name: string) => void;
}

/**
 * Store-connected boundary around {@link AIComposerDock} so composer keystrokes,
 * draft attachments, selection chips, and queued-send badges re-render ONLY the
 * composer dock — leaving `AISlidePanel`, `AIWorkspacePanelView`, and
 * `AIConversationView` untouched during typing.
 */
export function AIComposerDockConnected({
  copy,
  textareaRef,
  baseContextChars,
  contextLimitTokens,
  ...rest
}: AIComposerDockConnectedProps) {
  const promptDraft = useAIPanelStore((state) => state.promptDraft);
  const composerAttachments = useAIPanelStore((state) => state.composerAttachments);
  const attachedSelection = useAIPanelStore((state) => state.attachedSelection);
  const pendingQueueCount = useAIPanelStore((state) => state.pendingQueue.length);

  const footerNote = attachedSelection
    ? `${copy.composer.selectionReady} · ${attachedSelection.source}`
    : "";

  const contextUsage = useMemo(
    () => ({
      used: estimateTokensFromChars(baseContextChars + promptDraft.length),
      limit: contextLimitTokens,
    }),
    [baseContextChars, contextLimitTokens, promptDraft.length],
  );

  return (
    <AIComposerDock
      copy={copy}
      prompt={promptDraft}
      textareaRef={textareaRef}
      footerNote={footerNote}
      contextUsage={contextUsage}
      attachedSelectionSource={attachedSelection?.source}
      hasAttachedSelectionText={Boolean(attachedSelection?.text.trim())}
      attachments={composerAttachments}
      pendingQueueCount={pendingQueueCount}
      {...rest}
    />
  );
}
