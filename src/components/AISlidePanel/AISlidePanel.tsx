import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { useAIStore } from "../../stores/aiStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { invokeMutation } from "../../utils/tauri-utils";
import { AIWorkspacePanelView } from "./AIWorkspacePanelView";
import { AI_REQUEST_REPLACED_MESSAGE } from "./ai-agent-action-requestor";
import {
  prunePersistedAIWorkspaceState,
  type PersistedAIWorkspaceState,
} from "./ai-conversation-state";
import { isDataReadApproved } from "./ai-data-read-approvals";
import { getAIWorkspaceCopy } from "./ai-workspace-copy";
import type { AIWorkspaceBubbleData } from "./ai-workspace-types";
import { useAgentScheduleRunner } from "./hooks/use-agent-schedule-runner";
import { useAIAssistantGeneration } from "./hooks/use-ai-assistant-generation";
import { useAIBubbleActions } from "./hooks/use-ai-bubble-actions";
import { useAIBubbleRerun, type PendingPrompt } from "./hooks/use-ai-bubble-rerun";
import { useAIChatThreads } from "./hooks/use-ai-chat-threads";
import { useAIChatWorkspaces } from "./hooks/use-ai-chat-workspaces";
import { useAICompactContext } from "./hooks/use-ai-compact-context";
import { useAIComposerAttachments } from "./hooks/use-ai-composer-attachments";
import { useAIComposerSend, useBuildLoadingBubble } from "./hooks/use-ai-composer-send";
import { useAIConsentGates } from "./hooks/use-ai-consent-gates";
import { useAIDashboardBubbleUpdates } from "./hooks/use-ai-dashboard-bubble-updates";
import { useAIPanelDerivedState } from "./hooks/use-ai-panel-derived-state";
import { useAIPanelPreferences } from "./hooks/use-ai-panel-preferences";
import { useAISlashMenu } from "./hooks/use-ai-slash-menu";
import { useAISlidePanel } from "./hooks/use-ai-slide-panel";
import { useAIWorkspaceBridge } from "./hooks/use-ai-workspace-bridge";
import { useAIWorkspaceEffects } from "./hooks/use-ai-workspace-effects";
import { useAIPanelStore } from "./store/aiPanelStore";

interface Props {
  isOpen: boolean;
  initialPrompt?: string;
  initialPromptNonce?: number;
  initialAttachment?: {
    text: string;
    source: string;
    boardId?: string;
  };
  initialAttachmentNonce?: number;
  onClose: () => void;
}

export function AISlidePanel({
  isOpen,
  initialPrompt = "",
  initialPromptNonce = 0,
  initialAttachment,
  initialAttachmentNonce = 0,
  onClose,
}: Props) {
  const { language } = useI18n();
  const aiCopy = useMemo(() => getAIWorkspaceCopy(language), [language]);
  const aiConfigs = useAIStore((state) => state.aiConfigs);
  const loadAIConfigs = useAIStore((state) => state.loadAIConfigs);
  const saveAIConfigs = useAIStore((state) => state.saveAIConfigs);
  const activeConnectionDbType = useConnectionStore(
    (state) =>
      state.connections.find((connection) => connection.id === state.activeConnectionId)?.db_type,
  );
  const denyPendingConsents = useAIPanelStore((state) => state.denyPendingConsents);
  const setStorePendingQueue = useAIPanelStore((state) => state.setPendingQueue);
  const activeGenerationBubbleIdRef = useRef<string | null>(null);
  const cancelledGenerationBubbleIdsRef = useRef(new Set<string>());
  const pendingQueueRef = useRef<PendingPrompt[]>(useAIPanelStore.getState().pendingQueue);
  const syncPendingQueue = useCallback(
    (nextQueue: PendingPrompt[]) => {
      pendingQueueRef.current = nextQueue;
      setStorePendingQueue(nextQueue);
    },
    [setStorePendingQueue],
  );
  const handlePanelGenerationCancelled = useCallback(() => {
    const activeBubbleId = activeGenerationBubbleIdRef.current;
    if (activeBubbleId) {
      cancelledGenerationBubbleIdsRef.current.add(activeBubbleId);
      activeGenerationBubbleIdRef.current = null;
    }
    syncPendingQueue([]);
    denyPendingConsents();
  }, [denyPendingConsents, syncPendingQueue]);

  const {
    activeProvider,
    tableContextCount,
    connectionId,
    currentDatabase,
    error,
    setError,
    isGenerating,
    isCancelling,
    isRunning,
    cancelGeneration,
    generateAssist,
    listCheckpoints,
    restoreCheckpoint,
    copyText,
    insertSql,
    runSql,
  } = useAISlidePanel({ isOpen, onGenerationCancelled: handlePanelGenerationCancelled });

  const handleClose = useCallback(() => {
    cancelGeneration();
    onClose();
  }, [cancelGeneration, onClose]);

  const {
    destructiveConsentPending,
    failoverConsentState,
    getCurrentVisualizationApprovalScope,
    handleResolveFailoverConsent,
    isSessionDataReadEnabled,
    requestDestructiveConsent,
    requestVisualizationReadConsent,
    resolveDestructiveConsent,
    resolveVisualizationConsent,
    setIsSessionDataReadEnabled,
    setSessionDataReadEnabled,
    setVisualizationApprovalScope,
    visualizationConsentPending,
  } = useAIConsentGates({
    connectionId,
    currentDatabase,
    language,
    activeProvider,
  });

  useAgentScheduleRunner({ generateAssist, isGenerating, connectionId, currentDatabase });

  const composerRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatThreadRef = useRef<HTMLDivElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  const bubbleDismissTimersRef = useRef(new Map<string, number>());
  const historySaveTimerRef = useRef<number | null>(null);
  const openSessionRef = useRef(0);
  const isOpenRef = useRef(isOpen);

  const historyHydrated = useAIPanelStore((state) => state.historyHydrated);
  const setHistoryHydrated = useAIPanelStore((state) => state.setHistoryHydrated);
  const setPromptDraft = useAIPanelStore((state) => state.setPromptDraft);
  const attachedSelection = useAIPanelStore((state) => state.attachedSelection);
  const setAttachedSelection = useAIPanelStore((state) => state.setAttachedSelection);
  const isAttachmentManagerOpen = useAIPanelStore((state) => state.isAttachmentManagerOpen);
  const setIsAttachmentManagerOpen = useAIPanelStore((state) => state.setIsAttachmentManagerOpen);
  const bubbles = useAIPanelStore((state) => state.bubbles);
  const setBubbles = useAIPanelStore((state) => state.setBubbles);
  const bubblesRef = useRef<AIWorkspaceBubbleData[]>(bubbles);
  bubblesRef.current = bubbles;
  const chatThreads = useAIPanelStore((state) => state.chatThreads);
  const setChatThreads = useAIPanelStore((state) => state.setChatThreads);
  const workspaceInteractionModes = useAIPanelStore((state) => state.workspaceInteractionModes);
  const setWorkspaceInteractionModes = useAIPanelStore(
    (state) => state.setWorkspaceInteractionModes,
  );
  const workspaceAgentAutonomy = useAIPanelStore((state) => state.workspaceAgentAutonomy);
  const setWorkspaceAgentAutonomy = useAIPanelStore((state) => state.setWorkspaceAgentAutonomy);
  const showThinking = useAIStore((state) => state.thinkingEnabled);
  const setShowThinking = useAIStore((state) => state.setThinkingEnabled);
  const activeThreadIdsByWorkspace = useAIPanelStore((state) => state.activeThreadIdsByWorkspace);
  const setActiveThreadIdsByWorkspace = useAIPanelStore(
    (state) => state.setActiveThreadIdsByWorkspace,
  );
  const storedActiveThreadId = useAIPanelStore((state) => state.activeThreadId);
  const setActiveThreadId = useAIPanelStore((state) => state.setActiveThreadId);
  const isHistoryOpen = useAIPanelStore((state) => state.isHistoryOpen);
  const setIsHistoryOpen = useAIPanelStore((state) => state.setIsHistoryOpen);

  const {
    activeChatWorkspace,
    activeChatWorkspaceId,
    chatDatabaseCatalog,
    chatWorkspaces,
    currentWorkspaceKey,
    handleCreateUserWorkspace,
    handleDeleteUserWorkspace,
    handleRebindChatWorkspaceDatabase,
    handleSelectChatWorkspace,
    initialThreadRef,
    lastWorkspaceKeyRef,
    renameChatWorkspace,
    saveChatContextDigest,
    setThreadMemories,
    threadMemories,
  } = useAIChatWorkspaces({
    connectionId,
    currentDatabase,
    isOpen,
    isGenerating,
    isRunning,
    historyHydrated,
    aiCopy,
  });

  const activeThreadId = storedActiveThreadId || initialThreadRef.current!.id;
  const [isSwitchingProvider, setIsSwitchingProvider] = useState(false);
  const isProviderFailingOver = useAIStore((state) => state.isProviderFailingOver);
  const isProviderSwitching = isSwitchingProvider || isProviderFailingOver;

  const initializedMountPromptRef = useRef(false);
  useEffect(() => {
    if (initializedMountPromptRef.current) return;
    initializedMountPromptRef.current = true;
    if (initialPrompt && !useAIPanelStore.getState().promptDraft) {
      setPromptDraft(initialPrompt);
    }
  }, [initialPrompt, setPromptDraft]);

  const {
    activeAgentAutonomy,
    activeInteractionMode,
    activeThreadBubbles,
    baseContextChars,
    bubbleCountByThread,
    contextLimitTokens,
    contextWindowLimit,
    conversationBubbles,
    currentThread,
    effectiveHistoryMessages,
    handleToggleSafeMode,
    hasConversation,
    historyBudget,
    isLongformComposer,
    latestConversationBubbleId,
    latestConversationBubbleSnapshot,
    latestReadyAssistantBubble,
    recentWorkspaceThreads,
    safeModeEnabled,
    sandboxPolicy,
    sessionDataReadButtonLabel,
    sessionDataReadButtonTitle,
    switchableProviders,
    workspaceContextMessages,
    workspaceThreads,
  } = useAIPanelDerivedState({
    activeChatWorkspace,
    activeProvider,
    activeThreadId,
    aiConfigs,
    bubbles,
    chatThreads,
    connectionId,
    currentDatabase,
    currentWorkspaceKey,
    isSessionDataReadEnabled,
    language,
    workspaceAgentAutonomy,
    workspaceInteractionModes,
  });

  const persistHistoryState = useCallback(async (state: PersistedAIWorkspaceState) => {
    const prunedState = prunePersistedAIWorkspaceState(state);
    await invokeMutation<void>("save_ai_workspace_history", { state: prunedState });
  }, []);

  const scrollChatToLatest = useCallback(() => {
    const jump = () => {
      const thread = chatThreadRef.current;
      if (!thread) return;
      thread.scrollTop = thread.scrollHeight;
    };
    window.requestAnimationFrame(() => {
      jump();
      window.requestAnimationFrame(jump);
    });
    window.setTimeout(jump, 60);
    window.setTimeout(jump, 180);
  }, []);

  useAIWorkspaceEffects({
    historyHydrated,
    isOpen,
    setChatThreads,
    setBubbles,
    setWorkspaceInteractionModes,
    setActiveThreadIdsByWorkspace,
    currentWorkspaceKey,
    initialThreadRef,
    activeThreadId,
    setActiveThreadId,
    setHistoryHydrated,
    hasConversation,
    scrollChatToLatest,
    currentThread,
    isGenerating,
    latestConversationBubbleId,
    latestConversationBubbleSnapshot,
    chatThreadRef,
    setIsHistoryOpen,
    isOpenRef,
    openSessionRef,
    isHistoryOpen,
    historyPanelRef,
    aiConfigs,
    loadAIConfigs,
    workspaceThreads,
    recentWorkspaceThreads,
    activeThreadIdsByWorkspace,
    lastWorkspaceKeyRef,
    setAttachedSelection,
    setPromptDraft,
    setError,
    initialPromptNonce,
    initialPrompt,
    composerTextareaRef,
    initialAttachmentNonce,
    initialAttachment,
    onClose,
    onRequestClose: handleClose,
    historySaveTimerRef,
    bubbleDismissTimersRef,
    bubbles,
    chatThreads,
    workspaceInteractionModes,
    persistHistoryState,
  });

  useEffect(() => {
    if (!connectionId) {
      setVisualizationApprovalScope(null);
      setIsSessionDataReadEnabled(false);
      return;
    }
    if (isDataReadApproved(connectionId, currentDatabase)) {
      setVisualizationApprovalScope(getCurrentVisualizationApprovalScope());
      setIsSessionDataReadEnabled(true);
    } else {
      setVisualizationApprovalScope(null);
      setIsSessionDataReadEnabled(false);
    }
  }, [
    isOpen,
    connectionId,
    currentDatabase,
    getCurrentVisualizationApprovalScope,
    setIsSessionDataReadEnabled,
    setVisualizationApprovalScope,
  ]);

  const buildLoadingBubble = useBuildLoadingBubble({
    activeInteractionMode,
    activeProvider,
    aiCopy,
    currentThread,
    currentWorkspaceKey,
    workspaceThreads,
  });

  const { completeWorkspaceRedirect, openMetricsBoardInWorkspace, openSqlInWorkspace } =
    useAIWorkspaceBridge({
      aiCopy,
      connectionId,
      currentDatabase,
      language,
      openSessionRef,
      setBubbles,
      setError,
    });

  const dashboardBubbleUpdates = useAIDashboardBubbleUpdates({ language, setBubbles });

  const { createAssistantBubble } = useAIAssistantGeneration({
    activeAgentAutonomy,
    activeConnectionDbType,
    activeInteractionMode,
    aiCopy,
    attachedSelection,
    buildLoadingBubble,
    completeWorkspaceRedirect,
    currentThread: currentThread ?? undefined,
    currentWorkspaceKey,
    dashboardBubbleUpdates,
    generateAssist,
    language,
    latestReadyAssistantBubble,
    openMetricsBoardInWorkspace,
    openSqlInWorkspace,
    requestVisualizationReadConsent,
    requestDestructiveConsent,
    runSql,
    setActiveThreadIdsByWorkspace,
    setBubbles,
    setChatThreads,
    setError,
    workspaceThreads,
    activeGenerationBubbleIdRef,
    cancelledGenerationBubbleIdsRef,
    openSessionRef,
  });

  const { handleCompactContext, isCompacting } = useAICompactContext({
    activeChatWorkspace,
    activeInteractionMode,
    activeThreadBubbles,
    aiCopy,
    currentThread,
    currentWorkspaceKey,
    language,
    saveChatContextDigest,
    setBubbles,
    setError,
    setThreadMemories,
  });
  const { handleAddComposerAttachmentFiles, handleRemoveComposerAttachment } =
    useAIComposerAttachments({ activeProvider, aiCopy, setError });

  const {
    commitSlashCommand,
    fileCommands,
    handleBackupCommand,
    handleComposerPromptChange,
    handleRollbackCommand,
    setSlashActiveIndex,
    setSlashDismissed,
    slashActiveIndex,
    slashMatches,
    slashMenuOpen,
  } = useAISlashMenu({
    connectionId,
    activeConnectionDbType,
    currentDatabase,
    language,
    aiCopy,
    setError,
    composerTextareaRef,
  });

  const {
    handleBubbleFeedback,
    handleEditRerun,
    handleRegenerateBubble,
    handleRetryBubble,
    runEditedPrompt,
  } = useAIBubbleRerun({
    bubbles,
    bubblesRef,
    connectionId,
    currentDatabase,
    historyBudget,
    isGenerating,
    language,
    pendingQueueRef,
    workspaceContextMessages,
    createAssistantBubble,
    setActiveThreadId,
    setBubbles,
    setPendingQueue: syncPendingQueue,
  });

  const {
    handleGenerate,
    handleAskUserOptionSelect,
    handleAskUserCustomInput,
    handleCancelGeneration,
  } = useAIComposerSend({
    activeChatWorkspace,
    activeConnectionDbType,
    activeGenerationBubbleIdRef,
    activeInteractionMode,
    activeThreadBubbles,
    aiCopy,
    bubblesRef,
    cancelGeneration,
    cancelledGenerationBubbleIdsRef,
    composerTextareaRef,
    connectionId,
    contextWindowLimit,
    createAssistantBubble,
    currentDatabase,
    currentThread,
    effectiveHistoryMessages,
    fileCommands,
    handleBackupCommand,
    handleCompactContext,
    handleRollbackCommand,
    isGenerating,
    listCheckpoints,
    pendingQueueRef,
    runEditedPrompt,
    setError,
    syncPendingQueue,
  });

  const handleComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashMenuOpen && slashMatches.length > 0) {
        const activeIndex = Math.min(slashActiveIndex, slashMatches.length - 1);
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSlashActiveIndex((current) => Math.min(current + 1, slashMatches.length - 1));
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSlashActiveIndex((current) => Math.max(current - 1, 0));
          return;
        }
        if ((event.key === "Enter" || event.key === "Tab") && !event.nativeEvent.isComposing) {
          event.preventDefault();
          commitSlashCommand(slashMatches[activeIndex].name);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setSlashDismissed(true);
          return;
        }
      }
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        void handleGenerate();
      }
    },
    [
      commitSlashCommand,
      handleGenerate,
      setSlashActiveIndex,
      setSlashDismissed,
      slashActiveIndex,
      slashMatches,
      slashMenuOpen,
    ],
  );

  const { handleCopyBubble, handleInsertBubble, handleOpenAgentRecord, handleRunBubble } =
    useAIBubbleActions({
      activeAgentAutonomy,
      activeConnectionDbType,
      aiCopy,
      connectionId,
      currentDatabase,
      language,
      openSessionRef,
      copyText,
      completeWorkspaceRedirect,
      insertSql,
      openMetricsBoardInWorkspace,
      openSqlInWorkspace,
      requestVisualizationReadConsent,
      runSql,
      setBubbles,
      setError,
      updateBubbleForDashboardActionFailed:
        dashboardBubbleUpdates.updateBubbleForDashboardActionFailed,
      updateBubbleForDashboardApplied: dashboardBubbleUpdates.updateBubbleForDashboardApplied,
      updateBubbleForDashboardNoChange: dashboardBubbleUpdates.updateBubbleForDashboardNoChange,
    });

  const {
    deleteThreadPending,
    handleCancelDeleteThread,
    handleConfirmDeleteThread,
    handleCreateChatThread,
    handleImportChatThreads,
    handleReloadChat,
    handleRenameChatThread,
    handleRequestDeleteThread,
    handleResetStage,
    handleSelectThread,
    importableChatThreads,
  } = useAIChatThreads({
    bubbles,
    chatThreads,
    workspaceThreads,
    currentWorkspaceKey,
    activeThreadId,
    activeThreadIdsByWorkspace,
    activeChatWorkspace,
    threadMemories,
    initialThreadRef,
    composerTextareaRef,
    initialPrompt,
    isGenerating,
    isRunning,
    language,
    cancelGeneration,
    setActiveThreadId,
    setActiveThreadIdsByWorkspace,
    setAttachedSelection,
    setBubbles,
    setChatThreads,
    setError,
    setIsHistoryOpen,
    setPromptDraft,
    setThreadMemories,
    setWorkspaceInteractionModes,
  });

  const {
    activateProvider: handleActivateProvider,
    toggleModelVisibility: handleToggleModelVisibility,
    openSettings: handleOpenAISettings,
    selectAgentAutonomy: handleSelectAgentAutonomy,
    selectInteractionMode: handleSelectInteractionMode,
  } = useAIPanelPreferences({
    aiConfigs,
    currentWorkspaceKey,
    saveAIConfigs,
    setError,
    setIsHistoryOpen,
    setIsSwitchingProvider,
    setWorkspaceAgentAutonomy,
    setWorkspaceInteractionModes,
  });

  if (!isOpen) return null;
  const visibleError = error && error !== AI_REQUEST_REPLACED_MESSAGE ? error : null;

  return (
    <AIWorkspacePanelView
      model={{
        activeAgentAutonomy,
        activeInteractionMode,
        activeProvider,
        aiCopy,
        baseContextChars,
        contextLimitTokens,
        bubbleCountByThread,
        composerRef,
        composerTextareaRef,
        connectionId,
        conversationBubbles,
        currentDatabase,
        currentThread,
        deleteThreadPending,
        historyPanelRef,
        isAttachmentManagerOpen,
        isCancelling,
        isGenerating,
        isHistoryOpen,
        isLongformComposer,
        isRunning,
        isSessionDataReadEnabled,
        language,
        recentWorkspaceThreads,
        sessionDataReadButtonLabel,
        sessionDataReadButtonTitle,
        showThinking,
        switchableProviders,
        tableContextCount,
        visibleError,
        visualizationConsentPending,
        destructiveConsentPending,
        failoverConsentPending: failoverConsentState,
        chatThreadRef,
        activeChatWorkspaceId,
        activeChatWorkspaceName: activeChatWorkspace?.name ?? null,
        activeChatWorkspaceContextUpdatedAt: activeChatWorkspace?.contextUpdatedAt ?? null,
        chatWorkspaces,
        importableChatThreads,
        threadMemories,
        isCompacting,
        isSwitchingProvider: isProviderSwitching,
        safeModeEnabled,
        sandboxPolicy,
        onToggleSafeMode: handleToggleSafeMode,
        listCheckpoints,
        restoreCheckpoint,
        close: handleClose,
        confirmDeleteThread: handleConfirmDeleteThread,
        createThread: handleCreateChatThread,
        reloadChat: () => void handleReloadChat(),
        dismissError: () => setError(null),
        dismissSelection: () => setAttachedSelection(null),
        generate: () => void handleGenerate(),
        cancelGeneration: handleCancelGeneration,
        sendAskUserReply: handleAskUserOptionSelect,
        focusComposerInput: handleAskUserCustomInput,
        openSettings: handleOpenAISettings,
        openAttachmentManager: () => setIsAttachmentManagerOpen(true),
        closeAttachmentManager: () => setIsAttachmentManagerOpen(false),
        addAttachmentFiles: handleAddComposerAttachmentFiles,
        removeAttachment: handleRemoveComposerAttachment,
        regenerateBubble: handleRegenerateBubble,
        clearPendingQueue: () => syncPendingQueue([]),
        editRerun: handleEditRerun,
        submitBubbleFeedback: handleBubbleFeedback,
        requestDeleteThread: handleRequestDeleteThread,
        renameThread: handleRenameChatThread,
        retryBubble: handleRetryBubble,
        runBubble: handleRunBubble,
        copyBubble: handleCopyBubble,
        insertBubble: handleInsertBubble,
        openAgentRecord: handleOpenAgentRecord,
        reset: handleResetStage,
        selectThread: handleSelectThread,
        setHistoryOpen: setIsHistoryOpen,
        setPromptDraft: handleComposerPromptChange,
        slashMenu: slashMenuOpen
          ? {
              commands: slashMatches,
              activeIndex: Math.min(slashActiveIndex, slashMatches.length - 1),
            }
          : null,
        onSelectSlashCommand: commitSlashCommand,
        setSessionDataReadEnabled,
        setShowThinking,
        selectAgentAutonomy: handleSelectAgentAutonomy,
        selectInteractionMode: handleSelectInteractionMode,
        activateProvider: (id, model) => {
          const wasRunning = isRunning || isGenerating;
          void handleActivateProvider(id, model).then(() => {
            if (!wasRunning) return;
            const target = aiConfigs.find((config) => config.id === id);
            const label = target?.name?.trim() || target?.model || model;
            if (!label) return;
            window.dispatchEvent(
              new CustomEvent("ai-provider-switched-during-run", {
                detail: { providerLabel: label },
              }),
            );
          });
        },
        toggleModelVisibility: (id, model) => void handleToggleModelVisibility(id, model),
        confirmVisualizationConsent: resolveVisualizationConsent,
        confirmDestructiveConsent: resolveDestructiveConsent,
        resolveFailoverConsent: handleResolveFailoverConsent,
        cancelDeleteThread: handleCancelDeleteThread,
        composerKeyDown: handleComposerKeyDown,
        compactContext: () => void handleCompactContext(false),
        selectChatWorkspace: handleSelectChatWorkspace,
        createChatWorkspace: handleCreateUserWorkspace,
        renameChatWorkspace: renameChatWorkspace,
        deleteChatWorkspace: handleDeleteUserWorkspace,
        importChatThreads: handleImportChatThreads,
        databases: chatDatabaseCatalog.map((item) => item.name),
        rebindChatWorkspace: handleRebindChatWorkspaceDatabase,
      }}
    />
  );
}
