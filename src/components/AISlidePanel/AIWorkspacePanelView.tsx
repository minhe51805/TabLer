import { History, Layers, MessageSquarePlus, MessageSquareText, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useState } from "react";
import type { KeyboardEventHandler, RefObject } from "react";
import {
  AI_PANEL_DEFAULT_WIDTH,
  AI_PANEL_MAX_WIDTH,
  AI_PANEL_MIN_WIDTH,
  useAIPanelResize,
} from "../../hooks/useAIPanelResize";
import { useAppLayoutStore } from "../../stores/appLayoutStore";
import type { AIProviderConfig } from "../../types";
import { ConfirmDialog } from "../ConfirmDialog";
import { AIBubbleDetailModal } from "./AIBubbleDetailModal";
import { AISqlConfirmDialog } from "./AISqlConfirmDialog";
import { AICheckpointPickerModal } from "./AICheckpointPickerModal";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";
import { formatThreadTimestamp, type AIChatThread } from "./ai-conversation-state";
import { AIComposerDock } from "./AIComposerDock";
import { AIConversationView } from "./AIConversationView";
import { AIWorkspaceSwitcher } from "./AIWorkspaceSwitcher";
import { AIWorkspaceChatActionModal } from "./AIWorkspaceChatActionModal";
import type { AIAgentRecordLink } from "./ai-agent-record-links";
import { AIAttachmentManager } from "./AIAttachmentManager";
import type { AIAttachmentDraft } from "../../utils/ai-attachments";
import type { SelectionContextState } from "./ai-panel-selection";
import type { AIWorkspaceAgentAutonomy, AIWorkspaceBubbleData, AIWorkspaceInteractionMode } from "./ai-workspace-types";

interface ConfirmState { title: string; message: string; confirmText: string; cancelText: string; }
export interface AIWorkspacePanelViewModel {
  activeAgentAutonomy: AIWorkspaceAgentAutonomy; activeInteractionMode: AIWorkspaceInteractionMode; activeProvider?: AIProviderConfig;
  aiCopy: AIWorkspaceCopy; attachedSelection: SelectionContextState | null; bubbleCountByThread: Map<string, number>; composerFooterNote: string;
  composerRef: RefObject<HTMLDivElement | null>; composerTextareaRef: RefObject<HTMLTextAreaElement | null>; connectionId: string | null;
  conversationBubbles: AIWorkspaceBubbleData[]; currentDatabase: string | null; currentThread: AIChatThread | null; deleteThreadPending: string | null;
  detailBubble: AIWorkspaceBubbleData | null; historyPanelRef: RefObject<HTMLDivElement | null>; isCancelling: boolean; isGenerating: boolean;
  isAttachmentManagerOpen: boolean; canAttachImages: boolean; composerAttachments: AIAttachmentDraft[];
  isHistoryOpen: boolean; isLongformComposer: boolean; isRunning: boolean; isSessionDataReadEnabled: boolean; isSwitchingProvider: boolean; safeModeEnabled: boolean; onToggleSafeMode: (next: boolean) => void;
  language: string; promptDraft: string; recentWorkspaceThreads: AIChatThread[]; renameThread: (threadId: string, label: string) => void; sessionDataReadButtonLabel: string;
  sessionDataReadButtonTitle: string; showThinking: boolean; switchableProviders: AIProviderConfig[]; tableContextCount: number; visibleError: string | null;
  visualizationConsentPending: ConfirmState | null; failoverConsentPending: ConfirmState | null; chatThreadRef: RefObject<HTMLDivElement | null>;
  contextUsage: { used: number; limit: number };
  activeChatWorkspaceId: string | null; activeChatWorkspaceName: string | null; activeChatWorkspaceContextUpdatedAt: number | null;
  chatWorkspaces: { id: string; name: string; contextUpdatedAt: number | null }[]; importableChatThreads: AIChatThread[]; threadMemories: Record<string, { title: string; keywords: string[]; summary: string }>; isCompacting: boolean;
  close: () => void; confirmDeleteThread: () => void; createThread: () => void; reloadChat: () => void; dismissError: () => void; dismissSelection: () => void;
  compactContext: () => void; selectChatWorkspace: (id: string | null) => void; createChatWorkspace: () => void;
  renameChatWorkspace: (id: string, name: string) => void; deleteChatWorkspace: (id: string) => void; importChatThreads: (ids: string[]) => void;
  databases: string[]; rebindChatWorkspace: (id: string, database: string) => void;
  generate: () => void; cancelGeneration: () => void; openSettings: () => void; requestDeleteThread: (id: string, event: React.MouseEvent) => void;
  openAttachmentManager: () => void; closeAttachmentManager: () => void; addAttachmentFiles: (files: File[]) => void; removeAttachment: (id: string) => void;
  retryBubble: (bubble: AIWorkspaceBubbleData) => void; rewriteBubble: (bubble: AIWorkspaceBubbleData, note: string) => void; runBubble: (bubble: AIWorkspaceBubbleData) => void;
  openAgentRecord: (link: AIAgentRecordLink) => void;
  copyBubble: (bubble: AIWorkspaceBubbleData) => void; insertBubble: (bubble: AIWorkspaceBubbleData) => void; reset: () => void; selectThread: (id: string) => void;
  setDetailBubbleId: (id: string | null) => void; setHistoryOpen: (value: boolean | ((value: boolean) => boolean)) => void;
  setPromptDraft: (value: string) => void; setSessionDataReadEnabled: (value: boolean) => void; setShowThinking: (value: boolean) => void;
  /** Open "/" command menu (null = hidden); selection runs the command. */
  slashMenu?: { commands: { name: string; description: string }[]; activeIndex: number } | null;
  onSelectSlashCommand?: (name: string) => void;
  selectAgentAutonomy: (value: AIWorkspaceAgentAutonomy) => void; selectInteractionMode: (value: AIWorkspaceInteractionMode) => void; activateProvider: (id: string, model?: string) => void; toggleModelVisibility: (id: string, model: string) => void;
  confirmVisualizationConsent: (value: boolean) => void; resolveFailoverConsent: (approved: boolean) => void; cancelDeleteThread: () => void; composerKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
}

export function AIWorkspacePanelView({ model: m }: { model: AIWorkspacePanelViewModel }) {
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Header "+" opens a two-step modal (new chat / bring in existing chats)
  // instead of starting a thread immediately.
  const [isChatActionModalOpen, setChatActionModalOpen] = useState(false);
  // Escalating to "full" run access is a risky switch, so it asks first.
  const [isFullAccessConfirmOpen, setFullAccessConfirmOpen] = useState(false);
  const handleSelectAgentAutonomy = useCallback(
    (autonomy: AIWorkspaceAgentAutonomy) => {
      if (autonomy === "full" && m.activeAgentAutonomy !== "full") {
        setFullAccessConfirmOpen(true);
        return;
      }
      m.selectAgentAutonomy(autonomy);
    },
    [m.activeAgentAutonomy, m.selectAgentAutonomy],
  );
  // Stable callbacks so the memoized AIConversationView skips re-renders
  // triggered by unrelated panel state (composer keystrokes, health ticks...).
  const handleOpenDetail = useCallback(
    (bubble: { id: string }) => m.setDetailBubbleId(bubble.id),
    [m.setDetailBubbleId],
  );
  const handleUseSuggestion = useCallback(
    (prompt: string) => m.setPromptDraft(prompt),
    [m.setPromptDraft],
  );
  const panelWidth = useAppLayoutStore((state) => state.aiPanelWidth);
  const setPanelWidth = useAppLayoutStore((state) => state.setAIPanelWidth);
  const onResizeHandleMouseDown = useAIPanelResize({
    enabled: true,
    width: panelWidth,
    setWidth: setPanelWidth,
  });
  return <div className="ai-workspace-overlay">
    {m.visibleError && <div className="ai-workspace-alert"><span>{m.visibleError}</span><button type="button" className="ai-workspace-alert-dismiss" onClick={m.dismissError}>{m.aiCopy.composer.alertDismiss}</button></div>}
    <div className="ai-workspace-stage ai-workspace-stage--sidebar">
      <aside className={`ai-workspace-sidebar ${m.isLongformComposer ? "is-longform" : ""}`} style={{ width: panelWidth }}><div className="ai-workspace-resize-handle" role="separator" aria-orientation="vertical" aria-valuenow={panelWidth} aria-valuemin={AI_PANEL_MIN_WIDTH} aria-valuemax={AI_PANEL_MAX_WIDTH} aria-label={m.aiCopy.composer.resizeHandleTitle} title={m.aiCopy.composer.resizeHandleTitle} onMouseDown={onResizeHandleMouseDown} onDoubleClick={() => setPanelWidth(AI_PANEL_DEFAULT_WIDTH)}><div className="ai-workspace-resize-handle-line" /></div><div ref={m.composerRef} className={`ai-workspace-composer is-docked ${m.isLongformComposer ? "is-longform" : ""} ${m.activeInteractionMode === "agent" ? "is-agent" : ""}`}><div className="ai-workspace-composer-body">
        <header className="ai-workspace-panel-header workspace-toolbar"><div className="workspace-toolbar-main ai-workspace-panel-header-main"><span className="workspace-toolbar-kicker">{m.aiCopy.composer.kicker}</span><div className="workspace-toolbar-title-row ai-workspace-panel-header-row"><span className="workspace-toolbar-title">{m.aiCopy.composer.title}</span></div></div><div className="workspace-toolbar-actions"><button type="button" className={`toolbar-btn icon-only ${m.isCompacting ? "is-active" : ""}`} onClick={m.compactContext} disabled={m.isCompacting} title={m.isCompacting ? m.aiCopy.workspace.compactRunning : m.aiCopy.workspace.compactAction}><Layers className="w-3.5 h-3.5" /></button><button type="button" className="toolbar-btn icon-only" onClick={() => setChatActionModalOpen(true)} title={m.aiCopy.composer.newChatTitle}><MessageSquarePlus className="w-3.5 h-3.5" /></button><button type="button" className="toolbar-btn icon-only is-close" onClick={m.close} title={m.aiCopy.composer.alertDismiss}><X className="w-3.5 h-3.5" /></button></div></header>
        <div className="ai-workspace-chat-tabs"><AIWorkspaceSwitcher copy={m.aiCopy.workspace} workspaces={m.chatWorkspaces} activeWorkspaceId={m.activeChatWorkspaceId} onSelectWorkspace={m.selectChatWorkspace} onCreateWorkspace={m.createChatWorkspace} onRenameWorkspace={m.renameChatWorkspace} onDeleteWorkspace={m.deleteChatWorkspace} databases={m.databases} currentDatabase={m.currentDatabase} onRebindWorkspace={m.rebindChatWorkspace} rebindLocked={m.isGenerating || m.isRunning} rebindLockedTitle={m.aiCopy.workspace.rebindLockedTitle} /><div className="ai-workspace-chat-toolbar-actions"><div ref={m.historyPanelRef} className={`ai-workspace-history-dropdown ${m.isHistoryOpen ? "is-open" : ""}`}>
                <button type="button" className="ai-workspace-history-toggle" onClick={() => m.setHistoryOpen((value) => !value)} title={m.aiCopy.composer.historyTitle} aria-label={m.aiCopy.composer.historyTitle}>
                  <History className="w-3.5 h-3.5" />
                  <span className="ai-workspace-history-toggle-count">{m.recentWorkspaceThreads.length}</span>
                </button>
                {m.isHistoryOpen && (
                  <div className="ai-workspace-history-popover">
                    <div className="ai-workspace-history-head">
                      <span className="ai-workspace-history-label">{m.aiCopy.composer.historyTitle}</span>
                    </div>
                    {m.recentWorkspaceThreads.length === 0 ? (
                      <div className="ai-workspace-history-empty">{m.aiCopy.composer.historyEmpty}</div>
                    ) : (
                      <div className="ai-workspace-history-list">
                        {m.recentWorkspaceThreads.map((thread) => {
                          const memoryTitle = m.threadMemories[thread.id]?.title;
                          const messageCount = m.bubbleCountByThread.get(thread.id) || 0;
                          return (
                            <div key={thread.id} className={`ai-workspace-history-item ${thread.id === m.currentThread?.id ? "is-active" : ""}`}>
                              {renamingThreadId === thread.id ? (
                                <input
                                  autoFocus
                                  type="text"
                                  className="ai-workspace-history-item-rename"
                                  value={renameDraft}
                                  onChange={(event) => setRenameDraft(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      m.renameThread(thread.id, renameDraft);
                                      setRenamingThreadId(null);
                                    }
                                    if (event.key === "Escape") setRenamingThreadId(null);
                                  }}
                                  onBlur={() => {
                                    m.renameThread(thread.id, renameDraft);
                                    setRenamingThreadId(null);
                                  }}
                                />
                              ) : (
                                <button type="button" className="ai-workspace-history-item-select" onClick={() => m.selectThread(thread.id)}>
                                  <MessageSquareText className="ai-workspace-history-item-icon w-3.5 h-3.5" />
                                  <span className="ai-workspace-history-item-title">{memoryTitle || thread.label}</span>
                                  <span className="ai-workspace-history-item-meta">
                                    {formatThreadTimestamp(thread.updatedAt || thread.createdAt, m.language)}
                                    <i className="ai-workspace-history-item-meta-dot" />
                                    {messageCount}
                                  </span>
                                </button>
                              )}
                              {renamingThreadId !== thread.id && (
                                <div className="ai-workspace-history-item-actions">
                                  <button type="button" className="ai-workspace-history-item-delete" title={m.aiCopy.composer.historyRenameTitle} onClick={(event) => {
                                    event.stopPropagation();
                                    setRenamingThreadId(thread.id);
                                    setRenameDraft(memoryTitle || thread.label);
                                  }}>
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                  <button type="button" className="ai-workspace-history-item-delete" title={m.aiCopy.composer.historyDeleteTitle} onClick={(event) => m.requestDeleteThread(thread.id, event)}>
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div><button type="button" className="ai-workspace-chat-tab-add" onClick={m.reloadChat} disabled={m.isGenerating || m.isRunning} title={m.aiCopy.composer.reloadChatTitle}><RotateCcw className="w-3.5 h-3.5" /></button></div></div>
        <AIConversationView bubbles={m.conversationBubbles} copy={m.aiCopy} threadRef={m.chatThreadRef} onOpenDetail={handleOpenDetail} onInsert={m.insertBubble} onRun={m.runBubble} onRetry={m.retryBubble} onOpenRecord={m.openAgentRecord} onUseSuggestion={handleUseSuggestion} />
        <AIComposerDock copy={m.aiCopy} prompt={m.promptDraft} textareaRef={m.composerTextareaRef} footerNote={m.composerFooterNote} contextUsage={m.contextUsage} attachedSelectionSource={m.attachedSelection?.source} hasAttachedSelectionText={Boolean(m.attachedSelection?.text.trim())} attachments={m.composerAttachments} canAttachImages={m.canAttachImages} onAddAttachmentFiles={m.addAttachmentFiles} onRemoveAttachment={m.removeAttachment} onOpenAttachmentManager={m.openAttachmentManager} interactionMode={m.activeInteractionMode} agentAutonomy={m.activeAgentAutonomy} activeProvider={m.activeProvider} providers={m.switchableProviders} isSwitchingProvider={m.isSwitchingProvider} isGenerating={m.isGenerating} isCancelling={m.isCancelling} isConnectionAvailable={Boolean(m.connectionId)} isSessionDataReadEnabled={m.isSessionDataReadEnabled} sessionDataReadLabel={m.sessionDataReadButtonLabel} sessionDataReadTitle={m.sessionDataReadButtonTitle} showThinking={m.showThinking} onPromptChange={m.setPromptDraft} onKeyDown={m.composerKeyDown} slashMenu={m.slashMenu} onSelectSlashCommand={m.onSelectSlashCommand} onDismissSelection={m.dismissSelection} onSelectInteractionMode={m.selectInteractionMode} onSelectAgentAutonomy={handleSelectAgentAutonomy} onActivateProvider={m.activateProvider} onToggleModelVisibility={m.toggleModelVisibility} onSetSessionDataReadEnabled={m.setSessionDataReadEnabled} onSetShowThinking={m.setShowThinking} onOpenSettings={m.openSettings} safeModeEnabled={m.safeModeEnabled} onToggleSafeMode={m.onToggleSafeMode} onCloseHistory={() => m.setHistoryOpen(false)} onGenerate={m.generate} onCancelGeneration={m.cancelGeneration} />
      </div></div></aside>
    </div>
    {m.detailBubble && <AIBubbleDetailModal bubble={m.detailBubble} isGenerating={m.isGenerating} isRunning={m.isRunning} onClose={() => m.setDetailBubbleId(null)} onCopy={m.copyBubble} onInsert={m.insertBubble} onRun={m.runBubble} onRewrite={m.rewriteBubble} />}
    <ConfirmDialog isOpen={m.visualizationConsentPending !== null} title={m.visualizationConsentPending?.title || "Allow AI data read?"} message={m.visualizationConsentPending?.message || ""} confirmText={m.visualizationConsentPending?.confirmText || "Allow"} cancelText={m.visualizationConsentPending?.cancelText || "Deny"} onConfirm={() => m.confirmVisualizationConsent(true)} onCancel={() => m.confirmVisualizationConsent(false)} />
    <ConfirmDialog isOpen={m.failoverConsentPending !== null} title={m.failoverConsentPending?.title || "Provider failed"} message={m.failoverConsentPending?.message || ""} confirmText={m.failoverConsentPending?.confirmText || "Allow auto-switch"} cancelText={m.failoverConsentPending?.cancelText || "Not now"} onConfirm={() => m.resolveFailoverConsent(true)} onCancel={() => m.resolveFailoverConsent(false)} />
    <ConfirmDialog isOpen={m.deleteThreadPending !== null} title={m.aiCopy.composer.historyDeleteTitle ?? "Delete conversation"} message={m.aiCopy.composer.historyDeleteConfirm ?? "Delete this conversation thread?"} confirmText="Delete" cancelText="Cancel" onConfirm={m.confirmDeleteThread} onCancel={m.cancelDeleteThread} />
    <AISqlConfirmDialog copy={m.aiCopy.composer} />
    <AICheckpointPickerModal copy={m.aiCopy.composer} />
    <ConfirmDialog
      isOpen={isFullAccessConfirmOpen}
      title={m.aiCopy.composer.autonomyFullConfirmTitle}
      message={m.aiCopy.composer.autonomyFullConfirmBody}
      confirmText={m.aiCopy.composer.autonomyFullConfirmAllow}
      cancelText={m.aiCopy.composer.sqlConfirmCancelLabel}
      onConfirm={() => {
        setFullAccessConfirmOpen(false);
        m.selectAgentAutonomy("full");
      }}
      onCancel={() => setFullAccessConfirmOpen(false)}
    />
    <AIAttachmentManager open={m.isAttachmentManagerOpen} copy={m.aiCopy} onClose={m.closeAttachmentManager} />
    <AIWorkspaceChatActionModal
      open={isChatActionModalOpen}
      copy={m.aiCopy.workspace}
      workspaceName={m.activeChatWorkspaceName}
      threads={m.importableChatThreads}
      threadMemories={m.threadMemories}
      language={m.language}
      onClose={() => setChatActionModalOpen(false)}
      onCreateNewChat={() => {
        setChatActionModalOpen(false);
        m.reset();
      }}
      onAddThreads={(threadIds) => {
        setChatActionModalOpen(false);
        m.importChatThreads(threadIds);
      }}
    />
  </div>;
}
