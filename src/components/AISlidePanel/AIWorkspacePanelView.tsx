import { History, Plus, RotateCcw, Target, Trash2, X } from "lucide-react";
import type { KeyboardEventHandler, RefObject } from "react";
import type { AIProviderConfig } from "../../types";
import { ConfirmDialog } from "../ConfirmDialog";
import { AIBubbleDetailModal } from "./AIBubbleDetailModal";
import type { AIWorkspaceCopy } from "./ai-workspace-copy";
import { formatThreadTimestamp, type AIChatThread } from "./ai-conversation-state";
import { AIComposerDock } from "./AIComposerDock";
import { AIConversationView } from "./AIConversationView";
import type { SelectionContextState } from "./ai-panel-selection";
import type { AIWorkspaceAgentAutonomy, AIWorkspaceBubbleData, AIWorkspaceInteractionMode } from "./ai-workspace-types";

interface ConfirmState { title: string; message: string; confirmText: string; cancelText: string; }
export interface AIWorkspacePanelViewModel {
  activeAgentAutonomy: AIWorkspaceAgentAutonomy; activeInteractionMode: AIWorkspaceInteractionMode; activeProvider?: AIProviderConfig;
  aiCopy: AIWorkspaceCopy; attachedSelection: SelectionContextState | null; bubbleCountByThread: Map<string, number>; composerFooterNote: string;
  composerRef: RefObject<HTMLDivElement | null>; composerTextareaRef: RefObject<HTMLTextAreaElement | null>; connectionId: string | null;
  conversationBubbles: AIWorkspaceBubbleData[]; currentDatabase: string | null; currentThread: AIChatThread | null; deleteThreadPending: string | null;
  detailBubble: AIWorkspaceBubbleData | null; historyPanelRef: RefObject<HTMLDivElement | null>; isCancelling: boolean; isGenerating: boolean;
  isHistoryOpen: boolean; isInspectMode: boolean; isLongformComposer: boolean; isRunning: boolean; isSessionDataReadEnabled: boolean; isSwitchingProvider: boolean;
  language: string; promptDraft: string; recentWorkspaceThreads: AIChatThread[]; selectionContext: SelectionContextState | null; sessionDataReadButtonLabel: string;
  sessionDataReadButtonTitle: string; showThinking: boolean; switchableProviders: AIProviderConfig[]; tableContextCount: number; visibleError: string | null;
  visualizationConsentPending: ConfirmState | null; chatThreadRef: RefObject<HTMLDivElement | null>;
  close: () => void; confirmDeleteThread: () => void; createThread: () => void; dismissError: () => void; dismissSelection: () => void;
  generate: () => void; cancelGeneration: () => void; openSettings: () => void; requestDeleteThread: (id: string, event: React.MouseEvent) => void;
  retryBubble: (bubble: AIWorkspaceBubbleData) => void; rewriteBubble: (bubble: AIWorkspaceBubbleData, note: string) => void; runBubble: (bubble: AIWorkspaceBubbleData) => void;
  copyBubble: (bubble: AIWorkspaceBubbleData) => void; insertBubble: (bubble: AIWorkspaceBubbleData) => void; reset: () => void; selectThread: (id: string) => void;
  setDetailBubbleId: (id: string | null) => void; setHistoryOpen: (value: boolean | ((value: boolean) => boolean)) => void; setInspectMode: (value: boolean | ((value: boolean) => boolean)) => void;
  setPromptDraft: (value: string) => void; setSessionDataReadEnabled: (value: boolean) => void; setShowThinking: (value: boolean) => void;
  selectAgentAutonomy: (value: AIWorkspaceAgentAutonomy) => void; selectInteractionMode: (value: AIWorkspaceInteractionMode) => void; activateProvider: (id: string) => void;
  confirmVisualizationConsent: (value: boolean) => void; cancelDeleteThread: () => void; composerKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
}

export function AIWorkspacePanelView({ model }: { model: AIWorkspacePanelViewModel }) {
  const m = model;
  return <div className="ai-workspace-overlay">
    {m.visibleError && <div className="ai-workspace-alert"><span>{m.visibleError}</span><button type="button" className="ai-workspace-alert-dismiss" onClick={m.dismissError}>{m.aiCopy.composer.alertDismiss}</button></div>}
    <div className="ai-workspace-stage ai-workspace-stage--sidebar">
      {m.isInspectMode && m.selectionContext?.rect && <><div className="ai-workspace-selection-highlight" style={{ left: m.selectionContext.rect.x, top: m.selectionContext.rect.y, width: m.selectionContext.rect.width, height: m.selectionContext.rect.height }} /><div className="ai-workspace-selection-badge" style={{ left: m.selectionContext.rect.x + 8, top: Math.max(12, m.selectionContext.rect.y - 30) }}><Target className="w-3 h-3" /><span>{m.aiCopy.composer.selectionReady}</span></div></>}
      <aside className={`ai-workspace-sidebar ${m.isLongformComposer ? "is-longform" : ""}`}><div ref={m.composerRef} className={`ai-workspace-composer is-docked ${m.isLongformComposer ? "is-longform" : ""} ${m.activeInteractionMode === "agent" ? "is-agent" : ""}`}><div className="ai-workspace-composer-body">
        <header className="ai-workspace-panel-header workspace-toolbar"><div className="workspace-toolbar-main ai-workspace-panel-header-main"><span className="workspace-toolbar-kicker">{m.aiCopy.composer.kicker}</span><div className="workspace-toolbar-title-row ai-workspace-panel-header-row"><span className="workspace-toolbar-title">{m.aiCopy.composer.title}</span><div className="workspace-toolbar-status"><span className="workspace-toolbar-status-pill">{m.activeProvider?.name || m.aiCopy.composer.noProvider}</span><span className="workspace-toolbar-status-pill">{m.tableContextCount} {m.tableContextCount === 1 ? m.aiCopy.composer.tableOne : m.aiCopy.composer.tableOther}</span></div></div></div><div className="workspace-toolbar-actions"><button type="button" className={`toolbar-btn icon-only ${m.isInspectMode ? "is-active" : ""}`} onClick={() => m.setInspectMode((value) => !value)} title={m.aiCopy.composer.inspectOffTitle}><Target className="w-3.5 h-3.5" /></button><button type="button" className="toolbar-btn icon-only" onClick={m.reset} title="Reset"><RotateCcw className="w-3.5 h-3.5" /></button><button type="button" className="toolbar-btn icon-only is-close" onClick={m.close} title={m.aiCopy.composer.alertDismiss}><X className="w-3.5 h-3.5" /></button></div></header>
        <div className="ai-workspace-chat-tabs"><span className="ai-workspace-chat-tab ai-workspace-chat-tab-current is-active">{m.currentThread?.label || "#1"}</span><div className="ai-workspace-chat-toolbar-actions"><div ref={m.historyPanelRef} className={`ai-workspace-history-dropdown ${m.isHistoryOpen ? "is-open" : ""}`}><button type="button" className="ai-workspace-history-toggle" onClick={() => m.setHistoryOpen((value) => !value)}><History className="w-3.5 h-3.5" /><span>{m.aiCopy.composer.historyTitle}</span><span>{m.recentWorkspaceThreads.length}</span></button>{m.isHistoryOpen && <div className="ai-workspace-history-popover"><div className="ai-workspace-history-list">{m.recentWorkspaceThreads.map((thread) => <div key={thread.id} className={`ai-workspace-history-item ${thread.id === m.currentThread?.id ? "is-active" : ""}`}><button type="button" className="ai-workspace-history-item-select" onClick={() => m.selectThread(thread.id)}><strong>{thread.label}</strong><span>{formatThreadTimestamp(thread.updatedAt || thread.createdAt, m.language)}</span></button><button type="button" className="ai-workspace-history-item-delete" onClick={(event) => m.requestDeleteThread(thread.id, event)}><Trash2 className="w-3.5 h-3.5" /></button><span>{m.bubbleCountByThread.get(thread.id) || 0}</span></div>)}</div></div>}</div><button type="button" className="ai-workspace-chat-tab-add" onClick={m.createThread}><Plus className="w-3.5 h-3.5" /></button></div></div>
        <AIConversationView bubbles={m.conversationBubbles} copy={m.aiCopy} showThinking={m.showThinking} threadRef={m.chatThreadRef} onOpenDetail={(bubble) => m.setDetailBubbleId(bubble.id)} onInsert={m.insertBubble} onRun={m.runBubble} onRetry={m.retryBubble} onUseSuggestion={(prompt) => m.setPromptDraft(prompt)} />
        <AIComposerDock copy={m.aiCopy} prompt={m.promptDraft} textareaRef={m.composerTextareaRef} footerNote={m.composerFooterNote} attachedSelectionSource={m.attachedSelection?.source} hasAttachedSelectionText={Boolean(m.attachedSelection?.text.trim())} interactionMode={m.activeInteractionMode} agentAutonomy={m.activeAgentAutonomy} activeProvider={m.activeProvider} providers={m.switchableProviders} isSwitchingProvider={m.isSwitchingProvider} isGenerating={m.isGenerating} isCancelling={m.isCancelling} isConnectionAvailable={Boolean(m.connectionId)} isSessionDataReadEnabled={m.isSessionDataReadEnabled} sessionDataReadLabel={m.sessionDataReadButtonLabel} sessionDataReadTitle={m.sessionDataReadButtonTitle} showThinking={m.showThinking} onPromptChange={m.setPromptDraft} onKeyDown={m.composerKeyDown} onDismissSelection={m.dismissSelection} onSelectInteractionMode={m.selectInteractionMode} onSelectAgentAutonomy={m.selectAgentAutonomy} onActivateProvider={m.activateProvider} onSetSessionDataReadEnabled={m.setSessionDataReadEnabled} onSetShowThinking={m.setShowThinking} onOpenSettings={m.openSettings} onCloseHistory={() => m.setHistoryOpen(false)} onGenerate={m.generate} onCancelGeneration={m.cancelGeneration} />
      </div></div></aside>
    </div>
    {m.detailBubble && <AIBubbleDetailModal bubble={m.detailBubble} isGenerating={m.isGenerating} isRunning={m.isRunning} onClose={() => m.setDetailBubbleId(null)} onCopy={m.copyBubble} onInsert={m.insertBubble} onRun={m.runBubble} onRewrite={m.rewriteBubble} />}
    <ConfirmDialog isOpen={m.visualizationConsentPending !== null} title={m.visualizationConsentPending?.title || "Allow AI data read?"} message={m.visualizationConsentPending?.message || ""} confirmText={m.visualizationConsentPending?.confirmText || "Allow"} cancelText={m.visualizationConsentPending?.cancelText || "Deny"} onConfirm={() => m.confirmVisualizationConsent(true)} onCancel={() => m.confirmVisualizationConsent(false)} />
    <ConfirmDialog isOpen={m.deleteThreadPending !== null} title={m.aiCopy.composer.historyDeleteTitle ?? "Delete conversation"} message={m.aiCopy.composer.historyDeleteConfirm ?? "Delete this conversation thread?"} confirmText="Delete" cancelText="Cancel" onConfirm={m.confirmDeleteThread} onCancel={m.cancelDeleteThread} />
  </div>;
}
