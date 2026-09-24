import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { useAIStore } from "../../stores/aiStore";
import { useAIAutonomyStore } from "../../stores/aiAutonomyStore";
import { useSafeModeStore } from "../../stores/safeModeStore";
import { resolveSandboxPolicy, type SandboxPolicy } from "./ai-execution-policy";
import { emitAppToast } from "../../utils/app-toast";
import { useConnectionStore } from "../../stores/connectionStore";
import { useUIStore } from "../../stores/uiStore";
import {
  AUTO_COMPACT_TRIGGER_CHARS,
  COMPACT_COMMAND,
  buildCompactTranscript,
  buildCompactUserPrompt,
  buildPostCompactHistory,
  buildWorkspaceContextMessages,
  deriveMemoryTitle,
  extractDigestFromReply,
  extractMemoryKeywords,
  isCompactCommand,
  estimateTokensFromChars,
  formatTokensCompact,
  resolveAutoCompactTokenLimit,
} from "../../utils/ai-context-compact";
import type { AIConversationMessage, MetricsWidgetType } from "../../types";
import type { AIMetricsWidgetSpec } from "../../utils/metrics-board-templates";
import { normalizeAIProviderConfigs } from "../../utils/ai-provider-registry";
import { invokeMutation } from "../../utils/tauri-utils";
import { getLinkedWorkspaceDir } from "../../hooks/useLinkedFolders";
import {
  buildComposerCommandContext,
  describeMissingCommandContext,
  describeMissingCommandContextItems,
  findFileCommandName,
  isBackupCommand,
  isRollbackCommand,
  type ResolvedFileCommand,
} from "./ai-slash-commands";
import { AIWorkspacePanelView } from "./AIWorkspacePanelView";
import { useAIAssistantGeneration } from "./hooks/use-ai-assistant-generation";
import { useAIDashboardBubbleUpdates } from "./hooks/use-ai-dashboard-bubble-updates";
import { useAIWorkspaceEffects } from "./hooks/use-ai-workspace-effects";
import { useAIPanelPreferences } from "./hooks/use-ai-panel-preferences";
import { AI_REQUEST_REPLACED_MESSAGE } from "./ai-agent-action-requestor";
import { resolveEditorAssistPrompt, useAISlidePanel } from "./hooks/use-ai-slide-panel";
import { useAgentScheduleRunner } from "./hooks/use-agent-schedule-runner";
import { useAIChatWorkspaces } from "./hooks/use-ai-chat-workspaces";
import { useAIConsentGates } from "./hooks/use-ai-consent-gates";
import { useAISlashMenu } from "./hooks/use-ai-slash-menu";
import { useAIChatThreads } from "./hooks/use-ai-chat-threads";
import { useAIBubbleActions } from "./hooks/use-ai-bubble-actions";
import { isDataReadApproved } from "./ai-data-read-approvals";
import { useAIBubbleRerun, type PendingPrompt } from "./hooks/use-ai-bubble-rerun";
import {
  getDefaultAIWorkspaceInteractionMode,
  isAIWorkspaceAgentAutonomy,
  DEFAULT_AI_WORKSPACE_AGENT_AUTONOMY,
  type AIWorkspaceAgentAutonomy,
  type AIWorkspaceBubbleData,
  type AIWorkspaceInteractionMode,
} from "./ai-workspace-types";
import { getAIWorkspaceCopy } from "./ai-workspace-copy";
import { isDashboardSelectionSource } from "./ai-visualization-intent";
import {
  estimateConversationFootprint,
  buildConversationHistoryMessages,
  createAIWorkspaceId,
  prunePersistedAIWorkspaceState,
  resolveHistoryBudget,
  summarizePromptForDisplay,
  type AIChatThread,
  type PersistedAIWorkspaceState,
} from "./ai-conversation-state";
import { buildPromptWithSelection, type SelectionContextState } from "./ai-panel-selection";
import {
  MAX_IMAGES_PER_TURN,
  processFilesIntoAttachmentDrafts,
  type AIAttachmentDraft,
} from "../../utils/ai-attachments";

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
interface OpenMetricsBoardResult {
  success: boolean;
  boardId?: string;
  error?: string;
  didChange: boolean;
  addedCount: number;
  addedTitles: string[];
  created: boolean;
}

const AI_WORKSPACE_AGENT_AUTONOMY_STORAGE_KEY = "tabler.ai.workspace.agentAutonomy.v1";

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
  // Bridge: the consent hook needs connectionId/currentDatabase/activeProvider
  // from useAISlidePanel, while useAISlidePanel needs denyPendingConsents for
  // onGenerationCancelled. A stable ref-forwarded wrapper breaks the cycle —
  // the real deny is wired right after the consent hook runs below.
  const denyPendingConsentsRef = useRef<() => void>(() => {});
  const denyPendingConsents = useCallback(() => denyPendingConsentsRef.current(), []);

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
  } = useAISlidePanel({ isOpen, onGenerationCancelled: denyPendingConsents });

  const {
    denyPendingConsents: denyPendingConsentsImpl,
    destructiveConsentPending,
    destructiveConsentResolverRef,
    failoverConsentState,
    getCurrentVisualizationApprovalScope,
    handleResolveFailoverConsent,
    isSessionDataReadEnabled,
    requestDestructiveConsent,
    requestVisualizationReadConsent,
    resolveDestructiveConsent,
    resolveVisualizationConsent,
    setDestructiveConsentPending,
    setIsSessionDataReadEnabled,
    setSessionDataReadEnabled,
    setVisualizationConsentPending,
    visualizationApprovalScopeRef,
    visualizationConsentPending,
    visualizationConsentResolverRef,
  } = useAIConsentGates({
    connectionId,
    currentDatabase,
    language,
    activeProvider,
  });
  denyPendingConsentsRef.current = denyPendingConsentsImpl;

  // P10: the panel is the app's only agent runtime, so scheduled agent tasks
  // are executed here — read-only, one at a time, and only when the workspace is
  // already on the task's own connection/database. A task that cannot run stays
  // queued instead of being skipped or claimed as a success.
  useAgentScheduleRunner({ generateAssist, isGenerating, connectionId, currentDatabase });

  const composerRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatThreadRef = useRef<HTMLDivElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  const bubbleDismissTimersRef = useRef(new Map<string, number>());
  const historySaveTimerRef = useRef<number | null>(null);
  const openSessionRef = useRef(0);
  const isOpenRef = useRef(isOpen);
  const activeGenerationBubbleIdRef = useRef<string | null>(null);
  const cancelledGenerationBubbleIdsRef = useRef(new Set<string>());
  const [historyHydrated, setHistoryHydrated] = useState(false);

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

  const [promptDraft, setPromptDraft] = useState(initialPrompt);
  const [bubbles, setBubbles] = useState<AIWorkspaceBubbleData[]>([]);
  // Mirror for drain-time lookups: a queued edit-rerun resolves its bubble
  // after the current run settles, when the `bubbles` closure is already stale.
  const bubblesRef = useRef<AIWorkspaceBubbleData[]>(bubbles);
  bubblesRef.current = bubbles;
  const [chatThreads, setChatThreads] = useState<AIChatThread[]>([]);
  const [workspaceInteractionModes, setWorkspaceInteractionModes] = useState<
    Record<string, AIWorkspaceInteractionMode>
  >({});
  const [workspaceAgentAutonomy, setWorkspaceAgentAutonomy] = useState<
    Record<string, AIWorkspaceAgentAutonomy>
  >(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(AI_WORKSPACE_AGENT_AUTONOMY_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") return {};
      const result: Record<string, AIWorkspaceAgentAutonomy> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (isAIWorkspaceAgentAutonomy(value)) result[key] = value;
      }
      return result;
    } catch {
      return {};
    }
  });
  // The "Thinking" toggle now lives in the AI store so the request builder can
  // gate reasoning per call (off = no thinking tokens). Persistence + migration
  // from the old localStorage key happen inside the store.
  const showThinking = useAIStore((state) => state.thinkingEnabled);
  const setShowThinking = useAIStore((state) => state.setThinkingEnabled);
  const [activeThreadIdsByWorkspace, setActiveThreadIdsByWorkspace] = useState<
    Record<string, string>
  >({});
  const [activeThreadId, setActiveThreadId] = useState<string>(initialThreadRef.current!.id);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isSwitchingProvider, setIsSwitchingProvider] = useState(false);
  const isProviderFailingOver = useAIStore((state) => state.isProviderFailingOver);
  // The composer model trigger shows the switching spinner for BOTH manual
  // picks and automatic failovers — either way the active provider is moving.
  const isProviderSwitching = isSwitchingProvider || isProviderFailingOver;
  const [attachedSelection, setAttachedSelection] = useState<SelectionContextState | null>(null);
  const [composerAttachments, setComposerAttachments] = useState<AIAttachmentDraft[]>([]);
  // Messages sent while a run is in flight wait here instead of being dropped:
  // the send path is single-slot (requestIdRef/streamingText are shared), so
  // concurrent sends would supersede each other. Drained in order after the
  // current run's createAssistantBubble resolves.
  const [pendingQueue, setPendingQueue] = useState<PendingPrompt[]>([]);
  const pendingQueueRef = useRef<PendingPrompt[]>([]);
  const [isAttachmentManagerOpen, setIsAttachmentManagerOpen] = useState(false);

  const workspaceThreads = useMemo(
    () => chatThreads.filter((thread) => thread.workspaceKey === currentWorkspaceKey),
    [chatThreads, currentWorkspaceKey],
  );
  const recentWorkspaceThreads = useMemo(
    () => [...workspaceThreads].sort((left, right) => right.updatedAt - left.updatedAt),
    [workspaceThreads],
  );
  const currentThread = useMemo(
    () =>
      workspaceThreads.find((thread) => thread.id === activeThreadId) ??
      workspaceThreads[0] ??
      null,
    [activeThreadId, workspaceThreads],
  );
  const activeInteractionMode = useMemo(
    () =>
      workspaceInteractionModes[currentWorkspaceKey] ??
      getDefaultAIWorkspaceInteractionMode(activeProvider?.allow_schema_context),
    [activeProvider?.allow_schema_context, currentWorkspaceKey, workspaceInteractionModes],
  );
  const activeAgentAutonomy = useMemo<AIWorkspaceAgentAutonomy>(
    () => workspaceAgentAutonomy[currentWorkspaceKey] ?? DEFAULT_AI_WORKSPACE_AGENT_AUTONOMY,
    [currentWorkspaceKey, workspaceAgentAutonomy],
  );
  // Mirror the active autonomy into a per-connection signal so AI-origin
  // workspace tabs (outside this panel) can honor the full-autonomy grant
  // for THIS connection only — another connection's tabs keep their own.
  useEffect(() => {
    if (!connectionId) return;
    useAIAutonomyStore.getState().setAutonomy(connectionId, activeAgentAutonomy);
  }, [activeAgentAutonomy, connectionId]);
  const activeThreadBubbles = useMemo(
    () =>
      !currentThread
        ? []
        : bubbles.filter(
            (bubble) =>
              bubble.threadId === currentThread.id &&
              bubble.workspaceKey === currentWorkspaceKey &&
              !bubble.compactedAt,
          ),
    [bubbles, currentThread, currentWorkspaceKey],
  );
  // Verbatim replay window scaled to the active model's context window (tokens),
  // clamped to the backend caps. Larger-context models keep more turns / fuller
  // text so long chats remember more; small/unknown models stay conservative.
  const historyBudget = useMemo(
    () =>
      resolveHistoryBudget(
        activeProvider?.model_settings?.[activeProvider.model ?? ""]?.context_window ?? null,
      ),
    [activeProvider],
  );
  const historyMessages = useMemo(
    () => buildConversationHistoryMessages(activeThreadBubbles, historyBudget),
    [activeThreadBubbles, historyBudget],
  );
  const workspaceContextMessages = useMemo(
    () => buildWorkspaceContextMessages(activeChatWorkspace?.contextDigest),
    [activeChatWorkspace?.contextDigest],
  );
  const effectiveHistoryMessages = useMemo(
    () => [...workspaceContextMessages, ...historyMessages],
    [workspaceContextMessages, historyMessages],
  );
  // Model context_window is authored in TOKENS (matches Claude-Code-style meters).
  // null = not configured → meter falls back to the auto-compact display window.
  const contextWindowLimit = useMemo(() => {
    const settings = activeProvider?.model_settings?.[activeProvider.model ?? ""];
    const configured = settings?.context_window;
    return configured && configured > 0 ? configured : null;
  }, [activeProvider]);
  // The meter counts the conversation FOOTPRINT (every visible bubble,
  // untrimmed) — not the trimmed send window. Otherwise /compact could never
  // visibly shrink the meter: it folds old bubbles into the digest, and the
  // send window was already capped at the last 4 bubbles before any compact.
  const contextUsage = useMemo(
    () => ({
      used: estimateTokensFromChars(
        estimateConversationFootprint(activeThreadBubbles) +
          workspaceContextMessages.reduce((sum, message) => sum + message.content.length, 0) +
          promptDraft.length,
      ),
      limit: contextWindowLimit ?? estimateTokensFromChars(AUTO_COMPACT_TRIGGER_CHARS),
    }),
    [contextWindowLimit, activeThreadBubbles, workspaceContextMessages, promptDraft],
  );
  const conversationBubbles = useMemo(
    () => [...activeThreadBubbles].sort((left, right) => left.createdAt - right.createdAt),
    [activeThreadBubbles],
  );
  const bubbleCountByThread = useMemo(() => {
    const counts = new Map<string, number>();
    bubbles
      .filter(
        (bubble) =>
          bubble.workspaceKey === currentWorkspaceKey &&
          bubble.status !== "loading" &&
          !bubble.compactedAt,
      )
      .forEach((bubble) => {
        counts.set(bubble.threadId, (counts.get(bubble.threadId) || 0) + 1);
      });
    return counts;
  }, [bubbles, currentWorkspaceKey]);
  const isLongformComposer = activeInteractionMode === "agent" || activeThreadBubbles.length >= 2;
  const hasConversation = conversationBubbles.length > 0;
  const latestConversationBubbleId =
    conversationBubbles[conversationBubbles.length - 1]?.id ?? null;
  const latestConversationBubbleSnapshot = useMemo(() => {
    const latestBubble = conversationBubbles[conversationBubbles.length - 1];
    if (!latestBubble) return null;
    return [
      latestBubble.id,
      latestBubble.status,
      latestBubble.preview.length,
      latestBubble.detail.length,
      latestBubble.sql?.length ?? 0,
      latestBubble.agentSteps?.length ?? 0,
      latestBubble.createdAt,
    ].join(":");
  }, [conversationBubbles]);
  const latestReadyAssistantBubble = useMemo(
    () =>
      [...conversationBubbles]
        .reverse()
        .find((bubble) => bubble.kind === "assistant" && bubble.status === "ready") ?? null,
    [conversationBubbles],
  );
  const switchableProviders = useMemo(() => {
    // Disabled providers are managed in the settings modal only; the composer
    // switcher lists enabled providers (each expandable into its models).
    const normalized = normalizeAIProviderConfigs(aiConfigs).filter((config) => config.is_enabled);
    return [...normalized].sort((left, right) => {
      const leftScore =
        (left.id === activeProvider?.id ? 4 : 0) +
        (left.is_enabled ? 2 : 0) +
        (left.is_primary ? 1 : 0);
      const rightScore =
        (right.id === activeProvider?.id ? 4 : 0) +
        (right.is_enabled ? 2 : 0) +
        (right.is_primary ? 1 : 0);
      return rightScore - leftScore;
    });
  }, [activeProvider?.id, aiConfigs]);
  const composerFooterNote = attachedSelection
    ? `${aiCopy.composer.selectionReady} · ${attachedSelection.source}`
    : "";

  const sessionDataReadButtonLabel =
    language === "vi"
      ? isSessionDataReadEnabled
        ? "Data: Bật"
        : "Data: Hỏi"
      : isSessionDataReadEnabled
        ? "Data: On"
        : "Data: Ask";
  const sessionDataReadButtonTitle = !connectionId
    ? language === "vi"
      ? "Hãy kết nối database trước khi bật quyền đọc live data."
      : "Connect to a database before enabling session-wide live data reads."
    : isSessionDataReadEnabled
      ? language === "vi"
        ? `Đang cho phép đọc live data cho ${currentDatabase || "database hiện tại"} — quyền được ghi nhớ cho database này, không hỏi lại. Bấm để thu hồi và quay lại chế độ hỏi từng lần.`
        : `Live data reads are allowed for ${currentDatabase || "the current database"} — remembered for this database, so it won't ask again. Click to revoke and go back to ask-per-request mode.`
      : language === "vi"
        ? `Đang ở chế độ hỏi từng lần cho ${currentDatabase || "database hiện tại"}. Bấm để cho phép đọc live data liên tục (sẽ hiện modal xác nhận).`
        : `The AI will ask before each live data read on ${currentDatabase || "the current database"}. Click to allow live data reads (a confirmation appears).`;

  const persistHistoryState = useCallback(async (state: PersistedAIWorkspaceState) => {
    const prunedState = prunePersistedAIWorkspaceState(state);
    await invokeMutation<void>("save_ai_workspace_history", { state: prunedState });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        AI_WORKSPACE_AGENT_AUTONOMY_STORAGE_KEY,
        JSON.stringify(workspaceAgentAutonomy),
      );
    } catch {
      // Ignore storage write failures (private mode, quota, etc.).
    }
  }, [workspaceAgentAutonomy]);

  const scrollChatToLatest = useCallback(() => {
    const jump = () => {
      const thread = chatThreadRef.current;
      if (!thread) return;
      thread.scrollTop = thread.scrollHeight;
    };
    // Run across several frames + a short timeout so the scroll lands after
    // markdown, code blocks, and agent steps finish laying out (their height
    // is not known on the first frame, which left the view stuck up top).
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
    visualizationApprovalScopeRef,
    setIsSessionDataReadEnabled,
    visualizationConsentResolverRef,
    setVisualizationConsentPending,
    destructiveConsentResolverRef,
    setDestructiveConsentPending,
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
    historySaveTimerRef,
    bubbleDismissTimersRef,
    bubbles,
    chatThreads,
    workspaceInteractionModes,
    persistHistoryState,
  });

  // Restore remembered data-read consent whenever the panel opens or the
  // target database changes. Must run AFTER useAIWorkspaceEffects (whose
  // open-reset clears the approval) so a remembered approval survives
  // opening the panel and app restarts; a database without a stored
  // approval re-arms the consent prompt.
  useEffect(() => {
    if (!connectionId) {
      visualizationApprovalScopeRef.current = null;
      setIsSessionDataReadEnabled(false);
      return;
    }
    if (isDataReadApproved(connectionId, currentDatabase)) {
      visualizationApprovalScopeRef.current = getCurrentVisualizationApprovalScope();
      setIsSessionDataReadEnabled(true);
    } else {
      visualizationApprovalScopeRef.current = null;
      setIsSessionDataReadEnabled(false);
    }
  }, [
    isOpen,
    connectionId,
    currentDatabase,
    getCurrentVisualizationApprovalScope,
    setIsSessionDataReadEnabled,
    visualizationApprovalScopeRef,
  ]);

  const buildLoadingBubble = useCallback(
    (
      prompt: string,
      options?: {
        mode?: "compose" | "inspect";
        promptSummary?: string;
        threadId?: string;
        workspaceKey?: string;
        interactionMode?: AIWorkspaceInteractionMode;
      },
    ): AIWorkspaceBubbleData => {
      const id = createAIWorkspaceId();
      const workspaceKey = options?.workspaceKey || currentWorkspaceKey;
      const threadId =
        options?.threadId || currentThread?.id || workspaceThreads[0]?.id || createAIWorkspaceId();
      const interactionMode = options?.interactionMode || activeInteractionMode;
      return {
        id,
        threadId,
        workspaceKey,
        interactionMode,
        kind: "assistant",
        status: "loading",
        title:
          options?.mode === "inspect"
            ? aiCopy.bubbleStates.loadingInspectTitle
            : aiCopy.bubbleStates.loadingComposeTitle,
        subtitle:
          options?.mode === "inspect"
            ? aiCopy.bubbleStates.loadingInspectSubtitle
            : activeProvider?.name || aiCopy.composer.noProvider,
        prompt,
        promptSummary: options?.promptSummary || summarizePromptForDisplay(prompt),
        preview:
          options?.mode === "inspect"
            ? aiCopy.bubbleStates.loadingInspectPreview
            : aiCopy.bubbleStates.loadingComposePreview,
        detail: "",
        agentSteps:
          interactionMode === "agent"
            ? [
                {
                  step: 1,
                  action: "plan",
                  message: "",
                  status: "running",
                },
              ]
            : undefined,
        x: 0,
        y: 0,
        pointer: {
          visible: false,
          x: 0,
          y: 0,
        },
        createdAt: Date.now(),
      };
    },
    [
      activeInteractionMode,
      activeProvider?.name,
      aiCopy,
      currentThread,
      currentWorkspaceKey,
      workspaceThreads,
    ],
  );

  const openSqlInWorkspace = useCallback(
    (
      sql: string,
      options?: {
        title?: string;
        viewMode?: "table" | "chart";
        autoRun?: boolean;
        focusWorkspace?: boolean;
      },
    ) => {
      const normalizedSql = sql.trim();
      if (!normalizedSql) return false;

      if (!connectionId) {
        setError(
          language === "vi"
            ? "Hãy kết nối database trước khi mở query AI trong workspace."
            : "Connect to a database before opening an AI query in the workspace.",
        );
        return false;
      }

      window.dispatchEvent(
        new CustomEvent("open-ai-workspace-query", {
          detail: {
            sql: normalizedSql,
            connectionId,
            database: currentDatabase || undefined,
            title: options?.title,
            resultViewMode: options?.viewMode ?? "table",
            autoRun: options?.autoRun ?? false,
            focusWorkspace: options?.focusWorkspace ?? false,
          },
        }),
      );
      return true;
    },
    [connectionId, currentDatabase, language, setError],
  );

  const openMetricsBoardInWorkspace = useCallback(
    async (options?: {
      title?: string;
      template?: "database-overview";
      mode?: "create" | "augment" | "rebuild" | "edit";
      boardId?: string;
      focusWorkspace?: boolean;
      editTargetTitle?: string;
      editTargetType?: MetricsWidgetType;
      editQuery?: string;
      editTitle?: string;
      aiWidgets?: AIMetricsWidgetSpec[];
    }) => {
      if (!connectionId) {
        setError(
          language === "vi"
            ? "Hãy kết nối database trước khi mở dashboard AI trong workspace."
            : "Connect to a database before opening an AI dashboard in the workspace.",
        );
        return {
          success: false,
          didChange: false,
          addedCount: 0,
          addedTitles: [],
          created: false,
        } satisfies OpenMetricsBoardResult;
      }

      const requestId = createAIWorkspaceId();

      const completion = await new Promise<OpenMetricsBoardResult>((resolve) => {
        const timeoutId = window.setTimeout(() => {
          window.removeEventListener("open-ai-metrics-board-complete", handleComplete);
          resolve({
            success: false,
            error:
              language === "vi"
                ? "Thao tac dashboard AI het thoi gian cho."
                : "The AI dashboard action timed out.",
            didChange: false,
            addedCount: 0,
            addedTitles: [],
            created: false,
          });
        }, 10_000);

        const handleComplete = (event: Event) => {
          const detail = (
            event as CustomEvent<{
              requestId?: string;
              success?: boolean;
              error?: string;
              boardId?: string;
              didChange?: boolean;
              addedCount?: number;
              addedTitles?: string[];
              created?: boolean;
            }>
          ).detail;
          if (detail?.requestId !== requestId) return;
          window.clearTimeout(timeoutId);
          window.removeEventListener("open-ai-metrics-board-complete", handleComplete);
          if (!detail.success && detail.error) {
            setError(detail.error);
          }
          resolve({
            success: Boolean(detail?.success),
            boardId: detail?.boardId,
            error: detail?.error,
            didChange: Boolean(detail?.didChange),
            addedCount: Math.max(0, detail?.addedCount ?? 0),
            addedTitles: Array.isArray(detail?.addedTitles)
              ? detail.addedTitles.filter((value) => typeof value === "string")
              : [],
            created: Boolean(detail?.created),
          });
        };

        window.addEventListener("open-ai-metrics-board-complete", handleComplete);
        window.dispatchEvent(
          new CustomEvent("open-ai-metrics-board", {
            detail: {
              requestId,
              template: options?.template ?? "database-overview",
              mode: options?.mode ?? "create",
              boardId: options?.boardId,
              editTargetTitle: options?.editTargetTitle,
              editTargetType: options?.editTargetType,
              editQuery: options?.editQuery,
              editTitle: options?.editTitle,
              aiWidgets: options?.aiWidgets,
              connectionId,
              database: currentDatabase || undefined,
              title: options?.title,
              focusWorkspace: options?.focusWorkspace ?? false,
            },
          }),
        );
      });

      return completion;
    },
    [connectionId, currentDatabase, language, setError],
  );

  const {
    updateBubbleForDashboardNoChange,
    updateBubbleForDashboardActionFailed,
    updateBubbleForDashboardEditNeedsClarification,
    updateBubbleForAttachedDashboardSummary,
    updateBubbleForDashboardApplied,
    updateBubbleForDashboardEdited,
    updateBubbleForDashboardRebuilt,
  } = useAIDashboardBubbleUpdates({ language, setBubbles });

  const completeWorkspaceRedirect = useCallback(
    (bubbleId?: string, sessionId?: number) => {
      if (typeof sessionId === "number" && sessionId !== openSessionRef.current) return;
      // Keep the conversation intact: instead of deleting the bubble and closing
      // the panel, mark the bubble as opened in a workspace tab so the user can
      // ask follow-up questions in the same thread.
      if (bubbleId) {
        setBubbles((current) =>
          current.map((bubble) =>
            bubble.id === bubbleId
              ? {
                  ...bubble,
                  kind: "result",
                  status: "ready",
                  title: aiCopy.bubbleStates.openedInWorkspaceTitle,
                  subtitle: aiCopy.bubbleStates.openedInWorkspaceSubtitle,
                  preview: aiCopy.bubbleStates.openedInWorkspacePreview,
                  detail: bubble.detail || aiCopy.bubbleStates.openedInWorkspacePreview,
                  autoDismissAt: undefined,
                }
              : bubble,
          ),
        );
      }
    },
    [aiCopy],
  );

  const { createAssistantBubble } = useAIAssistantGeneration({
    activeAgentAutonomy,
    activeConnectionDbType,
    activeInteractionMode,
    aiCopy,
    attachedSelection,
    buildLoadingBubble,
    completeWorkspaceRedirect,
    currentThread,
    currentWorkspaceKey,
    dashboardBubbleUpdates: {
      updateBubbleForDashboardApplied,
      updateBubbleForDashboardActionFailed,
      updateBubbleForAttachedDashboardSummary,
      updateBubbleForDashboardEditNeedsClarification,
      updateBubbleForDashboardEdited,
      updateBubbleForDashboardNoChange,
      updateBubbleForDashboardRebuilt,
    },
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

  const [isCompacting, setIsCompacting] = useState(false);

  const handleCompactContext = useCallback(
    async (
      silent = false,
    ): Promise<{ digest: string; recentHistory: AIConversationMessage[] } | null> => {
      if (isCompacting) return null;
      if (!activeChatWorkspace) {
        if (!silent) setError(aiCopy.workspace.compactNeedsWorkspace);
        return null;
      }
      const readyBubbles = activeThreadBubbles.filter(
        (bubble) => bubble.kind === "assistant" && bubble.status === "ready",
      );
      if (readyBubbles.length === 0) {
        if (!silent) setError(aiCopy.workspace.compactEmpty);
        return null;
      }

      setIsCompacting(true);
      try {
        const transcript = buildCompactTranscript(activeThreadBubbles);
        const reply = await useAIStore
          .getState()
          .askAI(
            buildCompactUserPrompt(
              transcript,
              activeChatWorkspace.contextDigest,
              activeChatWorkspace.name,
            ),
            "",
            "panel",
            "general",
            [],
          );
        const digest = extractDigestFromReply(reply);
        if (digest.trim()) {
          saveChatContextDigest(activeChatWorkspace.id, digest);
          try {
            await invokeMutation("save_workspace_context_snapshot", {
              workspaceId: activeChatWorkspace.id,
              kind: "digest",
              threadId: null,
              payload: { digest },
            });
          } catch (digestCacheError) {
            console.error("[AIWorkspace] Failed to cache digest:", digestCacheError);
          }
        }
        // Claude Code / opencode semantics: the digest is the essence of the
        // WHOLE conversation up to this point — every ready bubble is folded in
        // (the summarizer sees them all via buildCompactTranscript) and no
        // verbatim scrollback survives beside the digest afterwards.
        const sortedReady = [...readyBubbles].sort(
          (left, right) => left.createdAt - right.createdAt,
        );
        const removedIds = sortedReady.map((bubble) => bubble.id);

        // Archive the FULL thread transcript in the SQLite cache before touching
        // anything — compacting never destroys the original conversation (same
        // contract as opencode's pruned-but-stored entries / Claude Code's
        // pre-compaction scrollback).
        const beforeBubbles = activeThreadBubbles.filter(
          (bubble) => bubble.status !== "loading" && !bubble.compactedAt,
        );
        const beforeTokens = estimateTokensFromChars(estimateConversationFootprint(beforeBubbles));
        const beforeMessages = beforeBubbles.length;
        const compactedAt = Date.now();
        const archivedBubbles = activeThreadBubbles.filter((bubble) => bubble.status !== "loading");
        try {
          await invokeMutation("save_workspace_context_snapshot", {
            workspaceId: activeChatWorkspace.id,
            kind: "transcript",
            threadId: currentThread?.id ?? null,
            payload: { compactedAt, bubbles: archivedBubbles },
          });
        } catch (archiveError) {
          console.error("[AIWorkspace] Failed to archive transcript:", archiveError);
        }

        if (removedIds.length > 0) {
          setBubbles((current) =>
            current.map((bubble) =>
              removedIds.includes(bubble.id) ? { ...bubble, compactedAt } : bubble,
            ),
          );
        }

        const effectiveDigest = digest.trim() || activeChatWorkspace.contextDigest;

        // Codex-style memory: name this thread's digest and tag it with
        // keywords so related context can be found and re-imported later.
        if (currentThread?.id && effectiveDigest.trim()) {
          const memoryTitle = deriveMemoryTitle(
            effectiveDigest,
            currentThread.label || activeChatWorkspace.name,
          );
          const memoryKeywords = extractMemoryKeywords(effectiveDigest);
          try {
            await invokeMutation("upsert_thread_memory", {
              workspaceId: activeChatWorkspace.id,
              threadId: currentThread.id,
              title: memoryTitle,
              summary: effectiveDigest,
              keywords: memoryKeywords,
            });
            setThreadMemories((current) => ({
              ...current,
              [currentThread.id]: {
                title: memoryTitle,
                keywords: memoryKeywords,
                summary: effectiveDigest,
              },
            }));
          } catch (memoryError) {
            console.error("[AIWorkspace] Failed to persist thread memory:", memoryError);
            emitAppToast({
              tone: "error",
              title:
                language === "vi" ? "Không lưu được ghi nhớ thread" : "Thread memory not saved",
              description:
                language === "vi"
                  ? "Tóm tắt ngữ cảnh của thread này sẽ không khả dụng cho các lượt sau."
                  : "This thread's context summary will not be available to future runs.",
              durationMs: 5000,
            });
          }
        }
        if (currentThread?.id) {
          const markerBubble: AIWorkspaceBubbleData = {
            id: createAIWorkspaceId(),
            threadId: currentThread.id,
            workspaceKey: currentWorkspaceKey,
            interactionMode: activeInteractionMode,
            kind: "assistant",
            status: "ready",
            title: aiCopy.workspace.compactDoneTitle,
            subtitle: aiCopy.workspace.compactDoneSubtitle,
            prompt: COMPACT_COMMAND,
            promptSummary: COMPACT_COMMAND,
            preview: summarizePromptForDisplay(effectiveDigest),
            detail: effectiveDigest,
            x: 0,
            y: 0,
            pointer: { x: 0, y: 0, visible: false },
            createdAt: Date.now(),
          };
          const afterTokens = estimateTokensFromChars(
            estimateConversationFootprint([markerBubble]),
          );
          const afterMessages = 1;
          markerBubble.subtitle = `${formatTokensCompact(beforeTokens)} → ${formatTokensCompact(afterTokens)} tokens · ${beforeMessages} → ${afterMessages} messages`;
          setBubbles((current) => [...current, markerBubble]);
        }
        return { digest: effectiveDigest, recentHistory: buildPostCompactHistory(effectiveDigest) };
      } catch (compactError) {
        setError(compactError instanceof Error ? compactError.message : String(compactError));
        return null;
      } finally {
        setIsCompacting(false);
      }
    },
    [
      activeChatWorkspace,
      activeInteractionMode,
      activeThreadBubbles,
      aiCopy.workspace.compactDoneSubtitle,
      aiCopy.workspace.compactDoneTitle,
      aiCopy.workspace.compactEmpty,
      aiCopy.workspace.compactNeedsWorkspace,
      currentThread?.id,
      currentThread?.label,
      currentWorkspaceKey,
      isCompacting,
      language,
      saveChatContextDigest,
      setError,
      setThreadMemories,
    ],
  );

  // The active model advertises image input via per-model `input_types` in the
  // settings modal. When it does not, images are still attached but the user
  // gets a one-time warning that the model may not support them.
  const canAttachImages = Boolean(
    activeProvider?.model &&
    activeProvider?.model_settings?.[activeProvider.model]?.input_types?.includes("image"),
  );
  const imageWarningModelRef = useRef<string | null>(null);

  const handleAddComposerAttachmentFiles = useCallback(
    async (files: File[]) => {
      const drafts = await processFilesIntoAttachmentDrafts(files);
      if (drafts.length === 0) return;
      const incomingImages = drafts.filter((draft) => draft.kind === "image").length;
      const existingImages = composerAttachments.filter((draft) => draft.kind === "image").length;
      const imageOverflow = incomingImages + existingImages > MAX_IMAGES_PER_TURN;
      setComposerAttachments((current) => {
        const existing = new Set(
          current.map((draft) => `${draft.kind}:${draft.name}:${draft.size}`),
        );
        const merged = [...current];
        let imageCount = current.filter((draft) => draft.kind === "image").length;
        drafts.forEach((draft) => {
          if (draft.kind === "image" && imageCount >= MAX_IMAGES_PER_TURN) return;
          const key = `${draft.kind}:${draft.name}:${draft.size}`;
          if (!existing.has(key)) {
            existing.add(key);
            if (draft.kind === "image") imageCount += 1;
            merged.push(draft);
          }
        });
        return merged;
      });
      if (imageOverflow) {
        setError(aiCopy.attachments.imageLimit);
      } else if (
        !canAttachImages &&
        incomingImages > 0 &&
        imageWarningModelRef.current !== (activeProvider?.model ?? "")
      ) {
        // Warn once per active model: the request still carries the images.
        imageWarningModelRef.current = activeProvider?.model ?? "";
        setError(aiCopy.attachments.imageMaybeUnsupported);
      }
    },
    [
      activeProvider?.model,
      aiCopy.attachments.imageLimit,
      aiCopy.attachments.imageMaybeUnsupported,
      canAttachImages,
      composerAttachments,
      setError,
    ],
  );

  const handleRemoveComposerAttachment = useCallback((id: string) => {
    setComposerAttachments((current) => current.filter((draft) => draft.id !== id));
  }, []);

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
    promptDraft,
    setPromptDraft,
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
    setPendingQueue,
  });

  const handleGenerate = useCallback(
    async (item?: PendingPrompt | string) => {
      const current: PendingPrompt =
        typeof item === "string"
          ? { kind: "prompt", draft: item, attachments: [], selection: null }
          : (item ?? {
              kind: "prompt",
              draft: promptDraft,
              attachments: composerAttachments,
              selection: attachedSelection,
            });
      if (isGenerating) {
        // The send path is single-slot: park the message and let the drain
        // loop below fire it once the in-flight run settles.
        if (current.kind === "rerun" || current.draft.trim() || current.attachments.length > 0) {
          pendingQueueRef.current = [...pendingQueueRef.current, current];
          setPendingQueue(pendingQueueRef.current);
          if (current.kind === "prompt") {
            setPromptDraft("");
            setComposerAttachments([]);
            if (!isDashboardSelectionSource(current.selection?.source)) {
              setAttachedSelection(null);
            }
          }
        }
        return;
      }
      const normalizedPrompt = (current.kind === "prompt" ? current.draft : "").trim();
      const currentSelection = current.kind === "prompt" ? current.selection : null;
      const currentAttachments = current.kind === "prompt" ? current.attachments : [];

      if (isCompactCommand(normalizedPrompt)) {
        setPromptDraft("");
        await handleCompactContext(false);
        return;
      }
      if (isBackupCommand(normalizedPrompt)) {
        setPromptDraft("");
        await handleBackupCommand();
        return;
      }
      if (isRollbackCommand(normalizedPrompt)) {
        setPromptDraft("");
        await handleRollbackCommand();
        return;
      }
      // File-backed runbooks (P5): `/profile orders` is expanded by the Rust
      // registry into the command body plus the facts it asked for, then sent as an
      // ordinary prompt — so it inherits the whole agent loop (guardrail rules,
      // verification, cost accounting) instead of opening a second execution path.
      let promptToRun = normalizedPrompt;
      // A file command's `allowed-tools:` narrows the run's tool set for this
      // send only — seeded into the executor as the initial restriction.
      let commandToolRestriction: string[] | undefined;
      // Editor-assist commands (/explain, /optimize, /fix): the composer keeps
      // the short `/name` draft while the model receives the expanded prompt —
      // active editor SQL, the last recorded error, or an EXPLAIN plan plus
      // index-advisor proposals. Native commands resolve before the file-backed
      // registry so a runbook can never shadow them.
      const editorAssist = await resolveEditorAssistPrompt({
        commandLine: normalizedPrompt,
        connectionId,
        dbType: activeConnectionDbType,
        databaseLabel: currentDatabase || null,
        attachedSql: currentSelection?.text ?? null,
      });
      if (editorAssist) {
        promptToRun = editorAssist.prompt;
        const missingContextNote = describeMissingCommandContextItems(editorAssist.missingContext);
        if (missingContextNote) {
          emitAppToast({
            tone: "info",
            title: `/${editorAssist.command}`,
            description: missingContextNote,
            durationMs: 8000,
          });
        }
      }
      if (findFileCommandName(normalizedPrompt, fileCommands)) {
        try {
          const connectionName = useConnectionStore
            .getState()
            .connections.find((connection) => connection.id === connectionId)?.name;
          // All six inject keys: the real active query tab's SQL (not just the
          // attached selection — /explain, /profile, /plan otherwise always
          // report missing context), the focused table, a compact schema
          // summary, and the checkpoint list.
          const uiState = useUIStore.getState();
          const activeTab = uiState.tabs.find((tab) => tab.id === uiState.activeTabId);
          const activeQueryTab =
            activeTab?.type === "query" && activeTab.connectionId === connectionId
              ? activeTab
              : null;
          const schemaSummary = useConnectionStore
            .getState()
            .tables.slice(0, 60)
            .map((table) => table.name)
            .join(", ");
          const checkpointList = connectionId
            ? await listCheckpoints(connectionId)
                .then((entries) =>
                  entries
                    .slice(0, 10)
                    .map(
                      (entry) =>
                        `${entry.label} (${new Date(entry.createdAt).toISOString()}, ${entry.tableCount} tables, ${entry.rowCount} rows)`,
                    )
                    .join("\n"),
                )
                .catch(() => "")
            : "";
          const resolved = await invokeMutation<ResolvedFileCommand>("resolve_ai_command", {
            // Linked-folder commands only resolve when the workspace dir is passed.
            workspaceDir: await getLinkedWorkspaceDir(),
            commandLine: normalizedPrompt,
            context: buildComposerCommandContext({
              currentDatabase,
              boundConnection: connectionName,
              activeTabSql: activeQueryTab?.content ?? currentSelection?.text ?? null,
              selectedTable:
                activeTab?.type === "table" || activeTab?.type === "structure"
                  ? (activeTab.tableName ?? activeTab.title)
                  : null,
              schemaSummary: schemaSummary || null,
              checkpointList: checkpointList || null,
            }),
          });
          promptToRun = resolved.prompt;
          // Narrowing-only contract: the command may take tools away, never
          // grant them. Empty array = no narrowing.
          commandToolRestriction =
            resolved.allowedTools.length > 0 ? resolved.allowedTools : undefined;
          const missingContextNote = describeMissingCommandContext(resolved);
          if (missingContextNote) {
            emitAppToast({
              tone: "info",
              title: `/${resolved.command.name}`,
              description: missingContextNote,
              durationMs: 8000,
            });
          }
        } catch (error) {
          // A command that cannot be expanded must NOT be sent verbatim: the model
          // would receive the literal text `/profile orders` and answer nonsense.
          setError(error instanceof Error ? error.message : String(error));
          return;
        }
      }

      const promptWithSelection = buildPromptWithSelection(promptToRun, currentSelection);
      if (!promptWithSelection.trim()) return;

      const displayPrompt =
        normalizedPrompt ||
        (currentSelection
          ? `${aiCopy.composer.selectionReady} · ${currentSelection.source}`
          : promptWithSelection);

      // The request is now captured in its own chat turn, so clear the composer
      // immediately instead of leaving an already-sent draft visible while it runs.
      setPromptDraft("");

      // Auto-compact: long workspace histories get summarized into the
      // workspace context digest before the request goes out, so the prompt
      // never grows unbounded (same idea as Claude Code auto-compact).
      let historyForRun = effectiveHistoryMessages;
      // Auto-compact against the same footprint the meter shows (hơn là window
      // trim đã cap sẵn ~10k — so sánh đó khiến auto-compact không bao giờ chạy).
      const historyChars = estimateConversationFootprint(activeThreadBubbles);
      // Compact at ~80% of the real model window (or the fixed fallback window)
      // so the summary happens BEFORE the window is full, not after we overflow.
      const overContextWindow =
        estimateTokensFromChars(historyChars) > resolveAutoCompactTokenLimit(contextWindowLimit);
      if (activeChatWorkspace && overContextWindow) {
        const compacted = await handleCompactContext(true);
        if (compacted) historyForRun = compacted.recentHistory;
      }

      const result = await createAssistantBubble(promptWithSelection, {
        mode: "compose",
        displayPrompt,
        userPrompt: normalizedPrompt || displayPrompt,
        attachmentSource: currentSelection?.source,
        history: historyForRun,
        threadId: currentThread?.id,
        interactionMode: activeInteractionMode,
        attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
        commandToolRestriction,
      });

      if (result?.success) {
        setComposerAttachments([]);
        if (!isDashboardSelectionSource(currentSelection?.source)) {
          setAttachedSelection(null);
        }
      }

      // Drain queued sends in order. The ref (not state) is read here because
      // this closure's `pendingQueue` is stale by the time the run resolves.
      while (pendingQueueRef.current.length > 0) {
        const next = pendingQueueRef.current[0];
        pendingQueueRef.current = pendingQueueRef.current.slice(1);
        setPendingQueue(pendingQueueRef.current);
        if (next.kind === "rerun") {
          const bubble = bubblesRef.current.find((entry) => entry.id === next.bubbleId);
          if (bubble) await runEditedPrompt(bubble, next.prompt);
          continue;
        }
        await handleGenerate(next);
      }
    },
    [
      activeChatWorkspace,
      activeConnectionDbType,
      activeInteractionMode,
      activeThreadBubbles,
      aiCopy.composer.selectionReady,
      attachedSelection,
      composerAttachments,
      connectionId,
      contextWindowLimit,
      createAssistantBubble,
      currentDatabase,
      currentThread?.id,
      effectiveHistoryMessages,
      fileCommands,
      handleBackupCommand,
      handleCompactContext,
      handleRollbackCommand,
      isGenerating,
      listCheckpoints,
      promptDraft,
      runEditedPrompt,
      setError,
    ],
  );

  // ask_user quick replies: clicking an option sends it as the next message;
  // the custom button just focuses the composer for free-form input.
  const handleAskUserOptionSelect = useCallback(
    (option: string) => {
      // Queued like any other send when a run is in flight — the option text
      // is the user's reply, it must not be dropped.
      void handleGenerate(option);
    },
    [handleGenerate],
  );
  const handleAskUserCustomInput = useCallback(() => {
    composerTextareaRef.current?.focus();
  }, []);

  const handleCancelGeneration = useCallback(() => {
    const activeBubbleId = activeGenerationBubbleIdRef.current;
    if (activeBubbleId) {
      cancelledGenerationBubbleIdsRef.current.add(activeBubbleId);
    }
    // Cancel means stop everything: queued sends would otherwise fire right
    // after the cancelled run settles.
    pendingQueueRef.current = [];
    setPendingQueue([]);
    cancelGeneration();
  }, [cancelGeneration]);

  const handleComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // The "/" command menu owns the keyboard while it is open: arrows move the
      // highlight, Enter/Tab park the highlighted command in the composer,
      // Escape dismisses. Picking never runs a command — the second Enter goes
      // through the ordinary send path.
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
      // Enter sends, Shift/Ctrl/Meta+Enter inserts a newline — the chat-app
      // convention. `isComposing` guards IME input (Vietnamese/Korean/Chinese):
      // the Enter that commits a composed word must not send the message.
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
      updateBubbleForDashboardActionFailed,
      updateBubbleForDashboardApplied,
      updateBubbleForDashboardNoChange,
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
    activeGenerationBubbleIdRef,
    cancelledGenerationBubbleIdsRef,
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

  const safeModeEnabled = useSafeModeStore((state) => state.settings.globalLevel >= 1);
  // Effective level for THIS connection (falls back to the global level) drives
  // the Codex-style sandbox posture badge shown on the composer.
  const sandboxEffectiveLevel = useSafeModeStore((state) =>
    connectionId ? state.getEffectiveLevel(connectionId) : state.settings.globalLevel,
  );
  const sandboxPolicy = useMemo<SandboxPolicy>(
    () => resolveSandboxPolicy(sandboxEffectiveLevel, activeAgentAutonomy),
    [sandboxEffectiveLevel, activeAgentAutonomy],
  );
  const handleToggleSafeMode = useCallback(
    (next: boolean) => {
      const store = useSafeModeStore.getState();
      const vi = language === "vi";
      if (next) {
        store.setGlobalLevel(1);
        emitAppToast({
          tone: "info",
          title: vi ? "Safe Mode: bật" : "Safe Mode: on",
          description: vi
            ? "Mức Read Only — mọi lệnh ghi bị chặn."
            : "Read Only level — every write statement is blocked.",
          durationMs: 6000,
        });
      } else {
        const level = store.settings.globalLevel;
        if (level >= 4) {
          emitAppToast({
            tone: "error",
            title: vi ? "Không thể tắt Safe Mode" : "Cannot disable Safe Mode",
            description: vi
              ? "Mức Strict/Paranoid chỉ hạ được trong Safe Mode settings."
              : "Strict/Paranoid levels can only be lowered in Safe Mode settings.",
            durationMs: 8000,
          });
          return;
        }
        store.setGlobalLevel(0);
        emitAppToast({
          tone: "success",
          title: vi ? "Safe Mode: tắt" : "Safe Mode: off",
          description: vi
            ? "Agent có thể chạy lệnh ghi không bị chặn. DROP/TRUNCATE vẫn bị cấm."
            : "The agent can run writes unblocked. DROP/TRUNCATE stay blocked.",
          durationMs: 8000,
        });
      }
    },
    [language],
  );
  if (!isOpen) return null;
  const visibleError = error && error !== AI_REQUEST_REPLACED_MESSAGE ? error : null;

  return (
    <AIWorkspacePanelView
      model={{
        activeAgentAutonomy,
        activeInteractionMode,
        activeProvider,
        aiCopy,
        attachedSelection,
        bubbleCountByThread,
        composerFooterNote,
        composerRef,
        composerTextareaRef,
        connectionId,
        conversationBubbles,
        currentDatabase,
        currentThread,
        deleteThreadPending,
        historyPanelRef,
        isAttachmentManagerOpen,
        composerAttachments,
        isCancelling,
        isGenerating,
        isHistoryOpen,
        isLongformComposer,
        isRunning,
        isSessionDataReadEnabled,
        language,
        promptDraft,
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
        contextUsage,
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
        close: () => {
          handleCancelGeneration();
          onClose();
        },
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
        addAttachmentFiles: (files) => void handleAddComposerAttachmentFiles(files),
        removeAttachment: handleRemoveComposerAttachment,
        regenerateBubble: (bubble) => void handleRegenerateBubble(bubble),
        pendingQueueCount: pendingQueue.length,
        clearPendingQueue: () => {
          pendingQueueRef.current = [];
          setPendingQueue([]);
        },
        editRerun: handleEditRerun,
        submitBubbleFeedback: handleBubbleFeedback,
        requestDeleteThread: handleRequestDeleteThread,
        renameThread: handleRenameChatThread,
        retryBubble: (bubble) => void handleRetryBubble(bubble),
        runBubble: (bubble) => void handleRunBubble(bubble),
        copyBubble: (bubble) => handleCopyBubble(bubble),
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
            // Mid-run manual switch: announce it in the conversation as
            // an inline agent step, like the automatic failover note.
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
